import { spawnSync } from 'node:child_process';
import { resolveConfig } from '../src/core/config.js';
import { resolveWatchdogKnobs } from '../src/core/knobs.js';
import { skillPaths } from '../src/core/run-context.js';
import { schemaValidQuiet } from '../src/core/schema.js';
import { providerRun } from '../src/providers/provider.js';
import { resolveRunnerBinaries } from '../src/providers/registry.js';
import type { ProviderRuntime } from '../src/providers/runtime.js';
import { packageRoot, projectRoot } from '../src/runtime/env.js';
import { Scratch } from '../src/runtime/scratch.js';

const DEFAULT_MODEL = 'sonnet';

type SmokeRole = 'creator' | 'critic' | 'reviewer' | 'judge';

interface SmokeContract {
  readonly name: string;
  readonly role: SmokeRole;
  readonly skillFile: string;
  readonly schemaFile: string;
  readonly tools: string;
  readonly disallowedTools: string;
  readonly prompt: string;
}

function selectedModel(): string {
  const model = process.env.SMOKE_MODEL?.trim() ?? '';
  return model === '' ? DEFAULT_MODEL : model;
}

function firstLine(value: string): string {
  return value.trim().split(/\r?\n/, 1)[0] ?? '';
}

function printClaudeVersion(claudeBin: string): void {
  const versionResult = spawnSync(claudeBin, ['--version'], { encoding: 'utf8' });
  const version = firstLine(versionResult.stdout) || firstLine(versionResult.stderr);
  console.log(`[claude-schema-smoke] claude-version=${version || 'unavailable'}`);
}

async function runContract(
  providerRuntime: ProviderRuntime,
  smokeContract: SmokeContract,
  scratch: Scratch,
): Promise<number> {
  const outFile = scratch.file();
  let status: number;
  try {
    status = await providerRun(
      providerRuntime,
      smokeContract.role,
      'json',
      outFile,
      smokeContract.skillFile,
      smokeContract.schemaFile,
      smokeContract.tools,
      smokeContract.disallowedTools,
      smokeContract.prompt,
    );
  } catch {
    console.error(`[claude-schema-smoke] FAIL ${smokeContract.name} provider-exception`);
    return 1;
  }
  if (status !== 0) {
    console.error(`[claude-schema-smoke] FAIL ${smokeContract.name} provider-status=${status}`);
    return status;
  }
  if (!schemaValidQuiet(outFile, smokeContract.schemaFile)) {
    console.error(`[claude-schema-smoke] FAIL ${smokeContract.name} canonical-validation`);
    return 1;
  }
  console.log(`[claude-schema-smoke] PASS ${smokeContract.name}`);
  return 0;
}

async function main(): Promise<number> {
  const scratch = Scratch.create('claude-schema-smoke');
  try {
    const root = packageRoot();
    const skills = skillPaths(root);
    const model = selectedModel();
    const resolved = resolveConfig({
      home: scratch.dir,
      env: {},
      overrides: {
        config: {
          settings: { quality: 'quick' },
          roles: {
            creator: { runner: 'claude', model },
            critic: { runner: 'claude', model },
            reviewer: { runner: 'claude', model },
            judge: { runner: 'claude', model },
          },
        },
      },
    }).config;
    const binaries = resolveRunnerBinaries();
    const providerRuntime: ProviderRuntime = {
      scratch,
      projectRoot: projectRoot(root),
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      streamKnobs: resolveWatchdogKnobs(resolved).stream,
      matrix: resolved.matrix,
      sessionMode: 0,
      creatorSessionFile: '',
      markdownSchemaPath: skills.markdownSchema,
      binaries,
      claudePermissionMode: resolved.providers.claudePermissionMode,
      livenessHeartbeatSeconds: 0,
      claudeThinkingEvery: resolved.providers.claudeThinkingEvery,
    };
    const contracts: readonly SmokeContract[] = [
      {
        name: 'clarification',
        role: 'creator',
        skillFile: skills.creatorSkill,
        schemaFile: skills.clarifySchema,
        tools: resolved.permissions.creator.createTools,
        disallowedTools: resolved.permissions.creator.createDisallowedTools,
        prompt:
          '## Prompt\nCreate a plan for this fully specified compatibility probe; no product decisions are missing.\n\n## Output mode: clarification questions\nReturn an empty questions list. Do not inspect the repository.\n',
      },
      {
        name: 'creator-update',
        role: 'creator',
        skillFile: skills.creatorSkill,
        schemaFile: skills.creatorSchema,
        tools: resolved.permissions.creator.updateTools,
        disallowedTools: resolved.permissions.creator.updateDisallowedTools,
        prompt:
          '## Plan\nplan.v0.md\n\n# Compatibility probe\n\nNo change is required.\n\n## Critique\n{"plan_version":0,"summary":"No issues.","issues":[]}\n\nReturn plan version 1 with the same non-empty plan and empty issue, applied, and rejected lists. Do not inspect the repository.\n',
      },
      {
        name: 'creator-update-metadata',
        role: 'creator',
        skillFile: skills.creatorSkill,
        schemaFile: skills.creatorMetaSchema,
        tools: resolved.permissions.creator.updateTools,
        disallowedTools: resolved.permissions.creator.updateDisallowedTools,
        prompt:
          '## Original plan\n# Compatibility probe\n\n## Revised plan\n# Compatibility probe\n\n## Critique\n{"plan_version":0,"summary":"No issues.","issues":[]}\n\nReturn metadata for plan version 1 with empty issue, applied, and rejected lists. Do not inspect the repository.\n',
      },
      {
        name: 'critique',
        role: 'critic',
        skillFile: skills.criticSkill,
        schemaFile: skills.criticSchema,
        tools: resolved.permissions.critic.tools,
        disallowedTools: resolved.permissions.critic.disallowedTools,
        prompt:
          '## Plan\nplan.v0.md\n\n# Compatibility probe\n\nThis synthetic plan tests JSON transport only.\n\n## Rejected log\n\nReturn a schema-valid critique for plan version 0. Do not inspect the repository.\n',
      },
      {
        name: 'fix-review',
        role: 'reviewer',
        skillFile: skills.reviewerSkill,
        schemaFile: skills.reviewerSchema,
        tools: resolved.permissions.reviewer.tools,
        disallowedTools: resolved.permissions.reviewer.disallowedTools,
        prompt:
          '## Original plan\n# Compatibility probe\n\n## Proposed fix\n# Compatibility probe\n\n## Findings\n[]\n\nReview this no-op proposal with no findings. Do not inspect the repository.\n',
      },
      {
        name: 'readiness',
        role: 'judge',
        skillFile: skills.judgeSkill,
        schemaFile: skills.judgeSchema,
        tools: resolved.permissions.judge.tools,
        disallowedTools: resolved.permissions.judge.disallowedTools,
        prompt:
          '## Plan\n# Compatibility probe\n\nThis synthetic plan tests JSON transport only.\n\n## Critique\n{"plan_version":0,"summary":"No issues.","issues":[]}\n\nReturn a schema-valid readiness judgment. Do not inspect the repository.\n',
      },
    ];

    printClaudeVersion(binaries.claude);
    console.log(`[claude-schema-smoke] model=${model} retries=0 sessions=0`);
    for (const smokeContract of contracts) {
      const status = await runContract(providerRuntime, smokeContract, scratch);
      if (status !== 0) {
        return status;
      }
    }
    return 0;
  } finally {
    scratch.sweep();
  }
}

try {
  process.exitCode = await main();
} catch {
  console.error('[claude-schema-smoke] FAIL setup');
  process.exitCode = 1;
}
