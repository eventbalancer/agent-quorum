import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { schemaValidQuiet } from '../../src/core/schema.js';
import { claudeJsonSchema } from '../../src/providers/claude.js';
import { providerRun } from '../../src/providers/provider.js';
import { DISABLED_STREAM_KNOBS, resolveRunnerBinaries } from '../../src/providers/registry.js';
import type { ProviderRuntime } from '../../src/providers/runtime.js';
import { Scratch } from '../../src/runtime/scratch.js';
import type { Role } from '../../src/types.js';
import { BASE_STREAM_KNOBS, fixtureMatrix } from '../helpers/test-context.js';
import {
  argvRecords,
  captureStderr,
  emptyCritique,
  SKILLS_DIR,
  withEnv,
  withEnvAsync,
  writeFakeBin,
  writeMarkdownWrapper,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';

const CRITIC_SKILL = path.join(SKILLS_DIR, 'plan-critic', 'SKILL.md');
const CRITIC_SCHEMA = path.join(SKILLS_DIR, 'plan-critic', 'critique.schema.json');
const CREATOR_SKILL = path.join(SKILLS_DIR, 'plan-creator', 'SKILL.md');
const CREATOR_CLARIFY_SCHEMA = path.join(SKILLS_DIR, 'plan-creator', 'clarify.schema.json');
const CREATOR_UPDATE_SCHEMA = path.join(SKILLS_DIR, 'plan-creator', 'update.schema.json');
const CREATOR_UPDATE_META_SCHEMA = path.join(SKILLS_DIR, 'plan-creator', 'update-meta.schema.json');
const REVIEWER_SKILL = path.join(SKILLS_DIR, 'plan-fix-reviewer', 'SKILL.md');
const REVIEWER_SCHEMA = path.join(SKILLS_DIR, 'plan-fix-reviewer', 'review.schema.json');
const JUDGE_SKILL = path.join(SKILLS_DIR, 'plan-judge', 'SKILL.md');
const JUDGE_SCHEMA = path.join(SKILLS_DIR, 'plan-judge', 'readiness.schema.json');
const TOOLS = 'Read,Grep,Glob';
const DISALLOWED = 'Write,Edit,NotebookEdit,Bash,Agent,Task,ToolSearch,AskUserQuestion';

let tmp: string;
let fake: string;
let scratch: Scratch;
let capture: StderrCapture;

function makeRuntime(partial?: Partial<ProviderRuntime>): ProviderRuntime {
  return {
    scratch,
    projectRoot: tmp,
    retry: { retryCount: 3, retryDelaySeconds: 0 },
    streamKnobs: {
      codex: DISABLED_STREAM_KNOBS,
      claude: BASE_STREAM_KNOBS,
      cursor: BASE_STREAM_KNOBS,
    },
    matrix: fixtureMatrix(),
    sessionMode: 0,
    creatorSessionFile: path.join(tmp, 'creator.session-id'),
    markdownSchemaPath: path.join(SKILLS_DIR, '_shared', 'markdown.schema.json'),
    binaries: { codex: 'codex', claude: 'claude', cursor: 'cursor-agent' },
    livenessHeartbeatSeconds: 0,
    claudeThinkingEvery: 3,
    ...partial,
  };
}

function strippedFile(file: string): string {
  return readFileSync(file, 'utf8').replace(/\n+$/, '');
}

function permissionModeFromArgv(record: readonly string[]): string {
  const index = record.indexOf('--permission-mode');
  return record[index + 1] ?? '';
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-provider.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  scratch = Scratch.create('provider-test');
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  scratch.sweep();
  rmSync(tmp, { recursive: true, force: true });
});

function fakePath(): string {
  return `${fake}:${process.env.PATH ?? ''}`;
}

describe('claude argv contract', () => {
  it('json mode argv byte-matches the reference order', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'out.json');
    const argvLog = path.join(tmp, 'claude.argv');
    const providerRuntime = makeRuntime({
      matrix: {
        ...fixtureMatrix(),
        critic: { runner: 'claude', model: 'claude-sonnet-4-6', reasoning: 'xhigh' },
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_JSON_RESULT: critique,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          TOOLS,
          DISALLOWED,
          'PROMPT BODY\n',
        ),
    );

    expect(status).toBe(0);
    const records = argvRecords(argvLog);
    expect(records).toEqual([
      [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--append-system-prompt',
        strippedFile(CRITIC_SKILL),
        '--permission-mode',
        'default',
        '--model',
        'claude-sonnet-4-6',
        '--json-schema',
        claudeJsonSchema(CRITIC_SCHEMA),
        '--effort',
        'xhigh',
        '--tools',
        TOOLS,
        '--allowed-tools',
        TOOLS,
        '--disallowed-tools',
        DISALLOWED,
      ],
    ]);
    expect(readFileSync(out, 'utf8')).toBe(strippedFile(critique));
  });

  it('creator create is read-only by toolset (no Bash granted; Bash denied)', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const out = path.join(tmp, 'plan.v0.md');
    const argvLog = path.join(tmp, 'claude.argv');
    const providerRuntime = makeRuntime();
    const createTools = 'Read,Grep,Glob';
    const createDisallowed = 'Write,Bash,Edit,NotebookEdit,Agent,Task,ToolSearch,AskUserQuestion';

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          createTools,
          createDisallowed,
          'Create.\n',
        ),
    );

    expect(status).toBe(0);
    const record = argvRecords(argvLog)[0] ?? [];
    expect(record).not.toContain('--json-schema');
    const toolsIdx = record.indexOf('--tools');
    const allowedIdx = record.indexOf('--allowed-tools');
    const disallowedIdx = record.indexOf('--disallowed-tools');
    expect(record[toolsIdx + 1]).toBe(createTools);
    expect(record[allowedIdx + 1]).toBe(createTools);
    expect(record[toolsIdx + 1]).not.toContain('Bash');
    expect(record[allowedIdx + 1]).not.toContain('Bash');
    expect(record[disallowedIdx + 1]).toBe(createDisallowed);
    expect(record[disallowedIdx + 1]).toContain('Bash');
    expect(permissionModeFromArgv(record)).toBe('default');
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(created, 'utf8'));
  });

  it('CLAUDE_PERMISSION_MODE=plan overrides the default for creator create and critic', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const createArgv = path.join(tmp, 'create.argv');
    const criticArgv = path.join(tmp, 'critic.argv');
    const providerRuntime = makeRuntime({
      claudePermissionMode: 'plan',
      matrix: {
        ...fixtureMatrix(),
        critic: { runner: 'claude', model: 'claude-sonnet-4-6', reasoning: 'xhigh' },
      },
    });

    const createStatus = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_ARGV_LOG: createArgv,
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          path.join(tmp, 'plan.v0.md'),
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Create.\n',
        ),
    );
    expect(createStatus).toBe(0);
    const createRecord = argvRecords(createArgv)[0] ?? [];
    expect(permissionModeFromArgv(createRecord)).toBe('plan');

    const criticStatus = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_JSON_RESULT: critique,
        FAKE_CLAUDE_ARGV_LOG: criticArgv,
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          path.join(tmp, 'critique.out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          TOOLS,
          DISALLOWED,
          'PROMPT BODY\n',
        ),
    );
    expect(criticStatus).toBe(0);
    const criticRecord = argvRecords(criticArgv)[0] ?? [];
    expect(permissionModeFromArgv(criticRecord)).toBe('plan');
  });

  it('an explicit runtime claudePermissionMode wins over CLAUDE_PERMISSION_MODE', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const argvLog = path.join(tmp, 'claude.argv');
    const providerRuntime = makeRuntime({ claudePermissionMode: 'plan' });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        CLAUDE_PERMISSION_MODE: 'default',
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          path.join(tmp, 'plan.v0.md'),
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Create.\n',
        ),
    );
    expect(status).toBe(0);
    const record = argvRecords(argvLog)[0] ?? [];
    expect(permissionModeFromArgv(record)).toBe('plan');
  });
});

interface ClaudeSchemaContract {
  readonly name: string;
  readonly role: Role;
  readonly skillFile: string;
  readonly schemaFile: string;
  readonly payload: unknown;
}

const CLAUDE_SCHEMA_CONTRACTS: readonly ClaudeSchemaContract[] = [
  {
    name: 'clarification',
    role: 'creator',
    skillFile: CREATOR_SKILL,
    schemaFile: CREATOR_CLARIFY_SCHEMA,
    payload: { questions: [] },
  },
  {
    name: 'creator update',
    role: 'creator',
    skillFile: CREATOR_SKILL,
    schemaFile: CREATOR_UPDATE_SCHEMA,
    payload: {
      plan_version: 1,
      plan_markdown: '# Updated plan',
      issues: [],
      applied: [],
      rejected_append: [],
    },
  },
  {
    name: 'creator update metadata',
    role: 'creator',
    skillFile: CREATOR_SKILL,
    schemaFile: CREATOR_UPDATE_META_SCHEMA,
    payload: { plan_version: 1, issues: [], applied: [], rejected_append: [] },
  },
  {
    name: 'critique',
    role: 'critic',
    skillFile: CRITIC_SKILL,
    schemaFile: CRITIC_SCHEMA,
    payload: { plan_version: 0, summary: 'Ready', issues: [] },
  },
  {
    name: 'fix review',
    role: 'reviewer',
    skillFile: REVIEWER_SKILL,
    schemaFile: REVIEWER_SCHEMA,
    payload: { approval: 'accept', concerns: [] },
  },
  {
    name: 'readiness judgment',
    role: 'judge',
    skillFile: JUDGE_SKILL,
    schemaFile: JUDGE_SCHEMA,
    payload: { ready: true, rationale: 'Ready' },
  },
];

describe('claude structured schema contracts', () => {
  for (const contract of CLAUDE_SCHEMA_CONTRACTS) {
    it(`projects and consumes the ${contract.name} contract`, async () => {
      const result = path.join(tmp, `${contract.name.replaceAll(' ', '-')}.result.json`);
      const out = path.join(tmp, `${contract.name.replaceAll(' ', '-')}.out.json`);
      const argvLog = path.join(tmp, `${contract.name.replaceAll(' ', '-')}.argv`);
      writeFileSync(result, `${JSON.stringify(contract.payload, null, 2)}\n`);
      const matrix = fixtureMatrix();
      matrix[contract.role] = {
        runner: 'claude',
        model: 'claude-sonnet-4-6',
        reasoning: 'high',
      };

      const status = await withEnvAsync(
        {
          PATH: fakePath(),
          FAKE_CLAUDE_JSON_RESULT: result,
          FAKE_CLAUDE_ARGV_LOG: argvLog,
          FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
        },
        () =>
          providerRun(
            makeRuntime({ matrix }),
            contract.role,
            'json',
            out,
            contract.skillFile,
            contract.schemaFile,
            TOOLS,
            DISALLOWED,
            'Return the minimal valid result.\n',
          ),
      );

      expect(status).toBe(0);
      expect(schemaValidQuiet(out, contract.schemaFile)).toBe(true);
      const argv = argvRecords(argvLog)[0] ?? [];
      expect(argv[argv.indexOf('--json-schema') + 1]).toBe(claudeJsonSchema(contract.schemaFile));
    });
  }
});

describe('claude schema rejection', () => {
  it('fails fast, preserves a resumed session, and keeps normal logs metadata-only', async () => {
    const argvLog = path.join(tmp, 'claude.argv');
    const skillFile = path.join(tmp, 'skill.md');
    const promptMarker = 'PROMPT-PLAN-PLANT-4d5237';
    const sourceMarker = 'SOURCE-BODY-PLANT-9d0d3e';
    const toolMarker = 'TOOL-ARGUMENT-PLANT-cf5a14';
    const credentialMarker = 'CREDENTIAL-TOKEN-PLANT-e81b7c';
    const stderrMarker = 'STDERR-DETAIL-PLANT-663f8a';
    writeFileSync(skillFile, `Inspect ${sourceMarker}.\n`);
    const providerRuntime = makeRuntime({ sessionMode: 1 });
    const sessionContents = '00000000-0000-4000-8000-00000000dead\n\n';
    writeFileSync(providerRuntime.creatorSessionFile, sessionContents);

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_ARGV_LOG: argvLog,
        FAKE_CLAUDE_SCHEMA_REJECT: '1',
        FAKE_CLAUDE_SCHEMA_REJECT_DETAIL: stderrMarker,
        FAKE_CLAUDE_SCHEMA_REJECT_STATUS: '17',
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'json',
          path.join(tmp, 'out.json'),
          skillFile,
          CREATOR_UPDATE_SCHEMA,
          `${TOOLS},${toolMarker}`,
          DISALLOWED,
          `${promptMarker}\n${credentialMarker}\n`,
        ),
    );

    expect(status).toBe(17);
    expect(argvRecords(argvLog)).toHaveLength(1);
    expect(readFileSync(providerRuntime.creatorSessionFile, 'utf8')).toBe(sessionContents);
    const text = capture.text();
    expect(text).toContain(
      'creator/claude call failed (status=17, stderr_lines=1): schema-incompatible',
    );
    expect(text).not.toContain('retry 1/3');
    expect(text).not.toContain('failed after');
    expect(text).not.toContain('session resume failed');
    for (const marker of [promptMarker, sourceMarker, toolMarker, credentialMarker, stderrMarker]) {
      expect(text).not.toContain(marker);
    }
  });

  it('removes a newly allocated session after rejection', async () => {
    const argvLog = path.join(tmp, 'claude.argv');
    const providerRuntime = makeRuntime({ sessionMode: 1 });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_ARGV_LOG: argvLog,
        FAKE_CLAUDE_SCHEMA_REJECT: '1',
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'json',
          path.join(tmp, 'out.json'),
          CREATOR_SKILL,
          CREATOR_UPDATE_SCHEMA,
          TOOLS,
          DISALLOWED,
          'Update.\n',
        ),
    );

    expect(status).toBe(1);
    expect(argvRecords(argvLog)).toHaveLength(1);
    expect(argvRecords(argvLog)[0]).toContain('--session-id');
    expect(existsSync(providerRuntime.creatorSessionFile)).toBe(false);
  });

  it('keeps raw schema diagnostics in the opt-in artifact only', async () => {
    const diagnosticsDir = path.join(tmp, 'diagnostics');
    const matrix = fixtureMatrix();
    matrix.critic = { runner: 'claude', model: 'claude-sonnet-4-6', reasoning: 'high' };

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_SCHEMA_REJECT: '1',
      },
      () =>
        providerRun(
          makeRuntime({ matrix, diagnosticsDir }),
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          TOOLS,
          DISALLOWED,
          'Critique.\n',
        ),
    );

    expect(status).toBe(1);
    const files = readdirSync(diagnosticsDir);
    expect(files).toHaveLength(1);
    const artifact = readFileSync(path.join(diagnosticsDir, files[0] ?? ''), 'utf8');
    expect(artifact).toContain('--json-schema is not a valid JSON Schema');
    expect(artifact).toContain(
      'no schema with key or ref "https://json-schema.org/draft/2019-09/schema"',
    );
    expect(capture.text()).toContain('schema-incompatible');
    expect(capture.text()).not.toContain('no schema with key or ref');
    expect(capture.text()).not.toContain('https://json-schema.org/draft/2019-09/schema');
  });

  it('still retries ordinary transient Claude JSON failures', async () => {
    const critique = path.join(tmp, 'critique.json');
    const attempts = path.join(tmp, 'attempts');
    emptyCritique(critique);
    const matrix = fixtureMatrix();
    matrix.critic = { runner: 'claude', model: 'claude-sonnet-4-6', reasoning: 'high' };

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_JSON_RESULT: critique,
        FAKE_CLAUDE_ATTEMPTS: attempts,
        FAKE_CLAUDE_FAILS: '2',
        FAKE_CLAUDE_REQUIRE_DRAFT7: '1',
      },
      () =>
        providerRun(
          makeRuntime({ matrix }),
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          TOOLS,
          DISALLOWED,
          'Critique.\n',
        ),
    );

    expect(status).toBe(0);
    expect(readFileSync(attempts, 'utf8')).toBe('3');
    expect(capture.text()).toContain('WARNING: claude call failed; retry 1/3');
    expect(capture.text()).not.toContain('schema-incompatible');
  });
});

describe('claude sessions', () => {
  it('establishes a session then resumes it', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const out = path.join(tmp, 'out.md');
    const argvLog = path.join(tmp, 'claude.argv');
    const providerRuntime = makeRuntime({ sessionMode: 1 });

    const env = {
      PATH: fakePath(),
      FAKE_CLAUDE_MARKDOWN_RESULT: created,
      FAKE_CLAUDE_ARGV_LOG: argvLog,
    };
    expect(
      await withEnvAsync(env, () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'First.\n',
        ),
      ),
    ).toBe(0);
    const sessionId = readFileSync(providerRuntime.creatorSessionFile, 'utf8').trim();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    expect(
      await withEnvAsync(env, () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Second.\n',
        ),
      ),
    ).toBe(0);

    const records = argvRecords(argvLog);
    expect(records).toHaveLength(2);
    expect(records[0]).toContain('--session-id');
    const first = records[0] ?? [];
    expect(first[first.indexOf('--session-id') + 1]).toBe(sessionId);
    expect(records[1]).toContain('--resume');
    const second = records[1] ?? [];
    expect(second[second.indexOf('--resume') + 1]).toBe(sessionId);
  });

  it('re-establishes a fresh session when resume fails', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const out = path.join(tmp, 'out.md');
    const argvLog = path.join(tmp, 'claude.argv');
    const providerRuntime = makeRuntime({
      sessionMode: 1,
      retry: { retryCount: 0, retryDelaySeconds: 0 },
    });
    const staleId = '00000000-0000-4000-8000-00000000dead';
    writeFileSync(providerRuntime.creatorSessionFile, `${staleId}\n`);

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
        FAKE_CLAUDE_FAIL_ON_RESUME: '1',
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Heal.\n',
        ),
    );

    expect(status).toBe(0);
    const records = argvRecords(argvLog);
    expect(records).toHaveLength(2);
    expect(records[0]).toContain('--resume');
    expect(records[1]).toContain('--session-id');
    const newId = readFileSync(providerRuntime.creatorSessionFile, 'utf8').trim();
    expect(newId).not.toBe(staleId);
    expect(capture.text()).toContain('creator session resume failed; re-establishing session');
  });

  it('resumes the same session once after a watchdog stall', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const out = path.join(tmp, 'out.md');
    const argvLog = path.join(tmp, 'claude.argv');
    const stallCounter = path.join(tmp, 'stall.count');
    const providerRuntime = makeRuntime({
      sessionMode: 1,
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      streamKnobs: {
        codex: DISABLED_STREAM_KNOBS,
        claude: { ...BASE_STREAM_KNOBS, byteTimeoutSeconds: 3 },
        cursor: BASE_STREAM_KNOBS,
      },
    });
    const liveId = '00000000-0000-4000-8000-0000000000aa';
    writeFileSync(providerRuntime.creatorSessionFile, `${liveId}\n`);

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
        FAKE_CLAUDE_STALL_ONCE: stallCounter,
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Stall.\n',
        ),
    );

    expect(status).toBe(0);
    expect(capture.text()).toContain('claude stream stalled');
    expect(capture.text()).toContain('creator stream stalled; resuming the same session once');
    const records = argvRecords(argvLog);
    expect(records).toHaveLength(2);
    const resumeRecord = records[1] ?? [];
    expect(resumeRecord[resumeRecord.indexOf('--resume') + 1]).toBe(liveId);
  }, 30_000);
});

describe('claude watchdog', () => {
  it('semantic idle terminates an api-retry loop', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const providerRuntime = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      streamKnobs: {
        codex: DISABLED_STREAM_KNOBS,
        claude: { ...BASE_STREAM_KNOBS, semanticTimeoutSeconds: 2 },
        cursor: BASE_STREAM_KNOBS,
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_API_RETRY_LOOP_ONCE: path.join(tmp, 'retry.loop'),
      },
      () =>
        providerRun(
          makeRuntime({ ...providerRuntime }),
          'creator',
          'markdown',
          path.join(tmp, 'o.md'),
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'X\n',
        ),
    );

    expect(status).toBe(124);
    expect(capture.text()).toContain('no semantic progress');
  }, 30_000);

  it('thinking heartbeats defer semantic idle until the wall clock fires', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const providerRuntime = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      streamKnobs: {
        codex: DISABLED_STREAM_KNOBS,
        claude: { ...BASE_STREAM_KNOBS, semanticTimeoutSeconds: 3, wallTimeoutSeconds: 5 },
        cursor: BASE_STREAM_KNOBS,
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_THINKING_LOOP_ONCE: path.join(tmp, 'thinking.loop'),
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          path.join(tmp, 'o.md'),
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'X\n',
        ),
    );

    expect(status).toBe(124);
    expect(capture.text()).toContain('wall-clock timeout');
    expect(capture.text()).not.toContain('no semantic progress');
  }, 30_000);

  it('wall-clock timeout terminates a busy stream', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const providerRuntime = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      streamKnobs: {
        codex: DISABLED_STREAM_KNOBS,
        claude: { ...BASE_STREAM_KNOBS, wallTimeoutSeconds: 3 },
        cursor: BASE_STREAM_KNOBS,
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_WALLCLOCK_LOOP_ONCE: path.join(tmp, 'wall.loop'),
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          path.join(tmp, 'o.md'),
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'X\n',
        ),
    );

    expect(status).toBe(124);
    expect(capture.text()).toContain('wall-clock timeout');
  }, 30_000);
});

describe('codex argv and retries', () => {
  it('argv byte-matches the stateless read-only contract', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'critique.out.json');
    const argvLog = path.join(tmp, 'codex.argv');
    const promptCapture = path.join(tmp, 'codex.prompt');
    const providerRuntime = makeRuntime();

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: promptCapture,
        FAKE_CODEX_ARGV_LOG: argvLog,
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'PROMPT BODY\n',
        ),
    );

    expect(status).toBe(0);
    const fullPrompt = `${strippedFile(CRITIC_SKILL)}\n\nPROMPT BODY`;
    expect(argvRecords(argvLog)).toEqual([
      [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-m',
        'gpt-5.5',
        '-c',
        'model_reasoning_effort="xhigh"',
        '--output-schema',
        CRITIC_SCHEMA,
        '-o',
        out,
        '--',
        fullPrompt,
      ],
    ]);
    expect(readFileSync(promptCapture, 'utf8')).toBe(fullPrompt);
    expect(existsSync(path.join(tmp, 'critic.session-id'))).toBe(false);
  });

  it('extracts plan markdown through the wrapper schema', async () => {
    const wrapper = path.join(tmp, 'wrapper.json');
    writeMarkdownWrapper(wrapper, 'Wrapped Plan');
    const out = path.join(tmp, 'plan.md');
    const providerRuntime = makeRuntime({
      matrix: {
        ...fixtureMatrix(),
        creator: { runner: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' },
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: wrapper,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          '',
          '',
          'Create.\n',
        ),
    );

    expect(status).toBe(0);
    const wrapped = JSON.parse(readFileSync(wrapper, 'utf8')) as { plan_markdown: string };
    expect(readFileSync(out, 'utf8')).toBe(`${wrapped.plan_markdown}\n`);
    expect(readFileSync(out, 'utf8')).toContain('Edge chars: "quoted" and backslash \\');
  });

  it('recovers through provider retries on transient failures', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'out.json');
    const attempts = path.join(tmp, 'attempts');

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_ATTEMPTS: attempts,
        FAKE_CODEX_FAILS: '2',
      },
      () =>
        providerRun(
          makeRuntime(),
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(0);
    expect(readFileSync(attempts, 'utf8')).toBe('3');
    expect(capture.text()).toContain('WARNING: codex call failed; retry 1/3');
  });

  it('retries successful transport when output validation rejects the artifact', async () => {
    const invalid = path.join(tmp, 'invalid.json');
    writeFileSync(invalid, '{"unexpected":true}\n');
    const valid = path.join(tmp, 'valid.json');
    emptyCritique(valid);
    const calls = path.join(tmp, 'output.calls');
    const out = path.join(tmp, 'out.json');
    const providerRuntime = makeRuntime({ retry: { retryCount: 1, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT_CALLS: calls,
        FAKE_CODEX_OUTPUT_1: invalid,
        FAKE_CODEX_OUTPUT_2: valid,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
          { validateOutput: (file) => schemaValidQuiet(file, CRITIC_SCHEMA) },
        ),
    );

    expect(status).toBe(0);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(schemaValidQuiet(out, CRITIC_SCHEMA)).toBe(true);
  });

  it('returns failure when output validation exhausts the retry policy', async () => {
    const invalid = path.join(tmp, 'invalid.json');
    writeFileSync(invalid, '{"unexpected":true}\n');
    const calls = path.join(tmp, 'output.calls');
    const providerRuntime = makeRuntime({ retry: { retryCount: 1, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: invalid,
        FAKE_CODEX_OUTPUT_CALLS: calls,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
          { validateOutput: (file) => schemaValidQuiet(file, CRITIC_SCHEMA) },
        ),
    );

    expect(status).toBe(1);
    expect(readFileSync(calls, 'utf8')).toBe('2');
    expect(capture.text()).toContain('codex call failed after 2 attempt(s)');
  });

  it('returns the last failure status when retries are exhausted', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const attempts = path.join(tmp, 'attempts');
    const providerRuntime = makeRuntime({ retry: { retryCount: 1, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_ATTEMPTS: attempts,
        FAKE_CODEX_FAILS: '9',
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(1);
    expect(readFileSync(attempts, 'utf8')).toBe('2');
    expect(capture.text()).toContain('codex call failed after 2 attempt(s)');
  });

  it('maps empty codex output to status 4', async () => {
    const empty = path.join(tmp, 'empty.json');
    writeFileSync(empty, '');
    const providerRuntime = makeRuntime({ retry: { retryCount: 0, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: empty,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(4);
    expect(capture.text()).toContain('codex produced empty output');
  });
});

// Mirrors the private phaseActiveRole filter in src/cli/status.ts: the liveness
// line must not be mistaken for a phase-active marker by `status`.
const PHASE_ACTIVE_ROLE_PATTERN =
  /iter=[0-9]+ — (critic|creator)|creating plan v0 from prompt|fix-pass: step [0-9]+ —/;

describe('codex liveness heartbeat', () => {
  it('emits a liveness line while a silent codex call is in flight (AC-1)', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'out.json');
    const providerRuntime = makeRuntime({ livenessHeartbeatSeconds: 1 });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_SILENT_SECONDS: '3',
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(0);
    expect(capture.text()).toContain('still working');
    expect(capture.text()).toContain('critic/codex');
    const heartbeatLine = capture
      .text()
      .split('\n')
      .find((line) => line.includes('still working'));
    expect(heartbeatLine).toBeDefined();
    expect(PHASE_ACTIVE_ROLE_PATTERN.test(heartbeatLine ?? '')).toBe(false);
  }, 30_000);

  it('emits no liveness line when the cadence is disabled with 0 (AC-3)', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'out.json');
    const providerRuntime = makeRuntime();

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_SILENT_SECONDS: '2',
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(0);
    expect(capture.text()).not.toContain('still working');
  }, 30_000);
});

describe('cursor adapter', () => {
  it('builds capability-probed argv, injects prompt hints, captures the session', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'out.json');
    const argvLog = path.join(tmp, 'cursor.argv');
    const promptCapture = path.join(tmp, 'cursor.prompt');
    const providerRuntime = makeRuntime({
      sessionMode: 1,
      matrix: {
        ...fixtureMatrix(),
        creator: { runner: 'cursor', model: 'composer-2.5', reasoning: 'high' },
      },
    });

    const env = {
      PATH: fakePath(),
      FAKE_CURSOR_JSON_RESULT: critique,
      FAKE_CURSOR_ARGV_LOG: argvLog,
      FAKE_CURSOR_PROMPT: promptCapture,
    };
    const status = await withEnvAsync(env, () =>
      providerRun(
        providerRuntime,
        'creator',
        'json',
        out,
        CREATOR_SKILL,
        CRITIC_SCHEMA,
        TOOLS,
        DISALLOWED,
        'Update.\n',
      ),
    );

    expect(status).toBe(0);
    expect(capture.text()).toContain(
      'WARNING: cursor runner ignores reasoning/effort field (reasoning=high)',
    );
    const records = argvRecords(argvLog);
    expect(records).toEqual([
      [
        '-p',
        '--output-format',
        'stream-json',
        '--workspace',
        tmp,
        '--model',
        'composer-2.5',
        '--trust',
        '--approve-mcps',
      ],
    ]);
    const prompt = readFileSync(promptCapture, 'utf8');
    expect(prompt.startsWith(strippedFile(CREATOR_SKILL))).toBe(true);
    expect(prompt).toContain('## Tool constraints');
    expect(prompt).toContain(`Use only these tools when inspecting the codebase: ${TOOLS}.`);
    expect(prompt).toContain('## JSON schema');
    expect(prompt).toContain(strippedFile(CRITIC_SCHEMA));
    expect(readFileSync(providerRuntime.creatorSessionFile, 'utf8')).toBe('cursor-session-fixture');
    expect(readFileSync(out, 'utf8')).toBe(strippedFile(critique));

    const status2 = await withEnvAsync(env, () =>
      providerRun(
        providerRuntime,
        'creator',
        'json',
        out,
        CREATOR_SKILL,
        CRITIC_SCHEMA,
        TOOLS,
        DISALLOWED,
        'Again.\n',
      ),
    );
    expect(status2).toBe(0);
    const second = argvRecords(argvLog)[1] ?? [];
    expect(second[second.indexOf('--resume') + 1]).toBe('cursor-session-fixture');
  });

  it('runs markdown mode and re-establishes a session when resume fails', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Cursor Created');
    const out = path.join(tmp, 'out.md');
    const argvLog = path.join(tmp, 'cursor.argv');
    const providerRuntime = makeRuntime({
      sessionMode: 1,
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      matrix: {
        ...fixtureMatrix(),
        creator: { runner: 'cursor', model: 'composer-2.5', reasoning: '' },
      },
    });
    writeFileSync(providerRuntime.creatorSessionFile, 'stale-cursor-session');

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CURSOR_MARKDOWN_RESULT: created,
        FAKE_CURSOR_ARGV_LOG: argvLog,
        FAKE_CURSOR_FAIL_ON_RESUME: '1',
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Heal.\n',
        ),
    );

    expect(status).toBe(0);
    expect(capture.text()).toContain(
      'creator cursor session resume failed; re-establishing session',
    );
    const records = argvRecords(argvLog);
    expect(records).toHaveLength(2);
    expect(records[0]).toContain('--resume');
    expect(records[1]).not.toContain('--resume');
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(created, 'utf8'));
    expect(readFileSync(providerRuntime.creatorSessionFile, 'utf8')).toBe('cursor-session-fixture');
  });

  it('retains transient retries for cursor calls', async () => {
    const result = path.join(tmp, 'cursor.json');
    emptyCritique(result);
    const attempts = path.join(tmp, 'cursor.attempts');
    const argvLog = path.join(tmp, 'cursor.argv');
    const out = path.join(tmp, 'out.json');
    const providerRuntime = makeRuntime({
      retry: { retryCount: 2, retryDelaySeconds: 0 },
      matrix: {
        ...fixtureMatrix(),
        creator: { runner: 'cursor', model: 'composer-2.5', reasoning: '' },
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CURSOR_JSON_RESULT: result,
        FAKE_CURSOR_ATTEMPTS: attempts,
        FAKE_CURSOR_FAILS: '2',
        FAKE_CURSOR_ARGV_LOG: argvLog,
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'json',
          out,
          CREATOR_SKILL,
          CRITIC_SCHEMA,
          TOOLS,
          DISALLOWED,
          'Retry.\\n',
        ),
    );

    expect(status).toBe(0);
    expect(readFileSync(attempts, 'utf8')).toBe('3');
    expect(argvRecords(argvLog)).toHaveLength(3);
  });
});

describe('cursor liveness heartbeat', () => {
  function cursorRuntime(partial?: Partial<ProviderRuntime>): ProviderRuntime {
    return makeRuntime({
      livenessHeartbeatSeconds: 1,
      matrix: {
        ...fixtureMatrix(),
        creator: { runner: 'cursor', model: 'composer-2.5', reasoning: '' },
      },
      ...partial,
    });
  }

  it('emits a liveness line while a silent cursor call is in flight (AC-2)', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Cursor Created');
    const out = path.join(tmp, 'out.md');
    const providerRuntime = cursorRuntime();

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CURSOR_MARKDOWN_RESULT: created,
        FAKE_CURSOR_SILENT_SECONDS: '3',
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Go.\n',
        ),
    );

    expect(status).toBe(0);
    expect(capture.text()).toContain('creator/cursor still working');
  }, 30_000);

  it('does not defer the byte-idle watchdog while the heartbeat is active (AC-5)', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Cursor Created');
    const out = path.join(tmp, 'out.md');
    const providerRuntime = cursorRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      streamKnobs: {
        codex: DISABLED_STREAM_KNOBS,
        claude: BASE_STREAM_KNOBS,
        cursor: { ...BASE_STREAM_KNOBS, byteTimeoutSeconds: 2 },
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CURSOR_MARKDOWN_RESULT: created,
        FAKE_CURSOR_SILENT_SECONDS: '5',
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Go.\n',
        ),
    );

    expect(status).toBe(124);
    expect(capture.text()).toContain('still working');
    expect(capture.text()).toContain('cursor stream stalled');
  }, 30_000);
});

describe('claude liveness heartbeat (AC-4)', () => {
  it('never emits a liveness line even when the cadence is configured', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Claude Created');
    const out = path.join(tmp, 'out.md');

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
      },
      () =>
        providerRun(
          makeRuntime({ livenessHeartbeatSeconds: 1 }),
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'X\n',
        ),
    );
    expect(status).toBe(0);
    expect(capture.text()).not.toContain('still working');
  });
});

describe('provider stderr capture (P2, AC-4)', () => {
  // A run of x's that only the fake bins' multi-MB no-newline line could produce;
  // its absence proves the raw stderr blob never reached the logs.
  const HUGE_MARKER = 'x'.repeat(64);

  it('drops raw codex stderr and surfaces a metadata-only failure summary', async () => {
    const PLANT = 'CODEX-STDERR-PLANT-7f3a9c-do-not-leak';
    const providerRuntime = makeRuntime({ retry: { retryCount: 0, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_STDERR: PLANT,
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(1);
    const text = capture.text();
    expect(text).not.toContain(PLANT);
    expect(text).not.toContain(HUGE_MARKER);
    expect(text).toContain('critic/codex call failed (status=1, stderr_lines=3): overloaded');
    expect(text).not.toContain('raw codex stderr');
  });

  it('drops raw claude stderr (streaming path) and surfaces a metadata-only summary', async () => {
    const PLANT = 'CLAUDE-STDERR-PLANT-7f3a9c-do-not-leak';
    const providerRuntime = makeRuntime({ retry: { retryCount: 0, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_STDERR: PLANT,
      },
      () =>
        providerRun(
          providerRuntime,
          'creator',
          'markdown',
          path.join(tmp, 'out.md'),
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'P\n',
        ),
    );

    expect(status).toBe(1);
    const text = capture.text();
    expect(text).not.toContain(PLANT);
    expect(text).not.toContain(HUGE_MARKER);
    expect(text).toContain('creator/claude call failed (status=1, stderr_lines=3): overloaded');
    expect(text).not.toContain('raw claude stderr');
  });
});

describe('provider opt-in diagnostics (P3, AC-3)', () => {
  const HUGE_MARKER = 'x'.repeat(64);

  it('streams raw stdout and stderr to a per-call artifact, logging only a reference line', async () => {
    const PLANT = 'DIAG-STDERR-PLANT-7f3a9c-do-not-leak';
    const diagnosticsDir = path.join(tmp, 'diagnostics');
    const providerRuntime = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      diagnosticsDir,
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_STDERR: PLANT,
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(1);
    const files = readdirSync(diagnosticsDir);
    expect(files).toHaveLength(1);
    const artifact = readFileSync(path.join(diagnosticsDir, files[0] ?? ''), 'utf8');
    // Raw stdout NDJSON and raw stderr (incl. the huge no-newline line) land in the artifact.
    expect(artifact).toContain('command_execution');
    expect(artifact).toContain(PLANT);
    expect(artifact).toContain(HUGE_MARKER);

    const text = capture.text();
    expect(text).toContain('critic/codex diagnostics → ');
    expect(text).toContain('critic/codex call failed (status=1, stderr_lines=');
    // Raw content never reaches normal logs.
    expect(text).not.toContain(PLANT);
    expect(text).not.toContain(HUGE_MARKER);
    expect(text).not.toContain('command_execution');
  });

  it('produces a distinct artifact per provider call with no overwrite', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const diagnosticsDir = path.join(tmp, 'diagnostics');
    const providerRuntime = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      diagnosticsDir,
    });
    const env = {
      PATH: fakePath(),
      FAKE_CODEX_OUTPUT: critique,
      FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      FAKE_CODEX_STREAM_EVENTS: 'started',
    };

    await withEnvAsync(env, () =>
      providerRun(
        providerRuntime,
        'critic',
        'json',
        path.join(tmp, 'a.json'),
        CRITIC_SKILL,
        CRITIC_SCHEMA,
        '',
        '',
        'A\n',
      ),
    );
    await withEnvAsync(env, () =>
      providerRun(
        providerRuntime,
        'critic',
        'json',
        path.join(tmp, 'b.json'),
        CRITIC_SKILL,
        CRITIC_SCHEMA,
        '',
        '',
        'B\n',
      ),
    );

    const files = readdirSync(diagnosticsDir);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);
  });

  it('writes no artifact when diagnostics are off', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const diagnosticsDir = path.join(tmp, 'diagnostics');
    const providerRuntime = makeRuntime({ retry: { retryCount: 0, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_STREAM_EVENTS: 'started',
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(0);
    expect(existsSync(diagnosticsDir)).toBe(false);
    expect(capture.text()).not.toContain('diagnostics →');
  });

  it('disables the sink with one bounded warning on a write failure, leaving the call intact', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const blocker = path.join(tmp, 'blocker');
    writeFileSync(blocker, 'not a dir');
    // diagnosticsDir nested under a regular file → mkdir fails (ENOTDIR).
    const diagnosticsDir = path.join(blocker, 'diagnostics');
    const providerRuntime = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      diagnosticsDir,
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_STREAM_EVENTS: 'started',
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(0);
    expect(existsSync(diagnosticsDir)).toBe(false);
    const text = capture.text();
    expect(text).not.toContain('command_execution');
    const warnings = text.split('\n').filter((line) => line.includes('diagnostics unavailable:'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('critic/codex diagnostics unavailable:');
  });
});

describe('provider stdout redaction through the real pipeline (AC-2)', () => {
  it('keeps body-bearing stdout NDJSON out of normal logs', async () => {
    const PLANT = 'STDOUTBODYPLANT7f3a9c';
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const providerRuntime = makeRuntime({ retry: { retryCount: 0, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_STDOUT_BODY: PLANT,
      },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(0);
    // Tool input, assistant prose, exec command, and retry reason all carried
    // the plant on stdout; only metadata reaches the logs.
    expect(capture.text()).not.toContain(PLANT);
  });
});

describe('binary SSOT', () => {
  it('the codex adapter spawns the resolved binaries.codex, not a literal', async () => {
    const out = path.join(tmp, 'out.json');
    const codexLog = path.join(tmp, 'codex.argv');
    const cursorLog = path.join(tmp, 'cursor.argv');
    // binaries.codex points at the distinct, PATH-present `cursor-agent` stub.
    // Post-SSOT the codex adapter spawns whatever binaries.codex names, so the
    // cursor stub records the codex argv while the literal `codex` stub (its own
    // FAKE_CODEX_ARGV_LOG) is never invoked.
    const providerRuntime = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      binaries: { codex: 'cursor-agent', claude: 'claude', cursor: 'cursor-agent' },
    });

    await withEnvAsync(
      { PATH: fakePath(), FAKE_CODEX_ARGV_LOG: codexLog, FAKE_CURSOR_ARGV_LOG: cursorLog },
      () =>
        providerRun(
          providerRuntime,
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'PROMPT BODY\n',
        ),
    );

    const spawned = argvRecords(cursorLog);
    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.[0]).toBe('exec');
    expect(argvRecords(codexLog)).toEqual([]);
  });

  it('resolveRunnerBinaries passes an empty AGENT_QUORUM_CURSOR_BIN through verbatim', () => {
    const binaries = withEnv({ AGENT_QUORUM_CURSOR_BIN: '' }, () => resolveRunnerBinaries());
    expect(binaries.cursor).toBe('');
    expect(binaries.codex).toBe('codex');
    expect(binaries.claude).toBe('claude');
  });
});
