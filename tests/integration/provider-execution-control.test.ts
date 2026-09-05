import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerRun } from '../../src/providers/provider.js';
import { DISABLED_STREAM_KNOBS } from '../../src/providers/registry.js';
import type { ProviderRuntime } from '../../src/providers/runtime.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { fixtureMatrix } from '../helpers/test-context.js';
import { argvRecords, SKILLS_DIR, writeFakeBin, withEnvAsync } from '../helpers/harness.js';

let root: string;
let scratch: Scratch;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'provider-control-'));
  scratch = Scratch.create('provider-control');
  writeFakeBin(path.join(root, 'bin'));
});
afterEach(() => {
  scratch.sweep();
  rmSync(root, { recursive: true, force: true });
});

function runtime(): ProviderRuntime {
  return {
    scratch,
    projectRoot: root,
    retry: { retryCount: 3, retryDelaySeconds: 0 },
    streamKnobs: {
      codex: DISABLED_STREAM_KNOBS,
      claude: DISABLED_STREAM_KNOBS,
      cursor: DISABLED_STREAM_KNOBS,
    },
    matrix: fixtureMatrix(),
    sessionMode: 0,
    creatorSessionFile: path.join(root, 'session'),
    markdownSchemaPath: path.join(SKILLS_DIR, '_shared', 'markdown.schema.json'),
    binaries: {
      codex: path.join(root, 'bin', 'codex'),
      claude: path.join(root, 'bin', 'claude'),
      cursor: path.join(root, 'bin', 'cursor-agent'),
    },
    livenessHeartbeatSeconds: 0,
    claudeThinkingEvery: 3,
  };
}

describe('provider task execution', () => {
  it('uses an explicit fresh task profile and accounts for each real retry spawn', async () => {
    const result = path.join(root, 'result.json');
    const output = path.join(root, 'out.json');
    const argv = path.join(root, 'argv');
    const envFile = path.join(root, 'supervised-env.json');
    const wrapper = path.join(root, 'supervised-codex');
    writeFileSync(
      wrapper,
      '#!' +
        process.execPath +
        '\n' +
        `const fs=require('node:fs'); fs.writeFileSync(${JSON.stringify(envFile)},JSON.stringify(process.env));const r=require('node:child_process').spawnSync('/bin/bash',[${JSON.stringify(path.join(root, 'bin/codex'))},...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,...${JSON.stringify({ FAKE_CODEX_OUTPUT: path.join(root, 'result.json'), FAKE_CODEX_PROMPT: path.join(root, 'prompt'), FAKE_CODEX_ARGV_LOG: argv, FAKE_CODEX_ATTEMPTS: path.join(root, 'attempts'), FAKE_CODEX_FAILS: '2' })}}});process.exit(r.status??1);`,
      { mode: 0o700 },
    );
    writeFileSync(result, '{"plan_markdown":"fixture"}');
    let reserved = 0;
    let started = 0;
    const status = await withEnvAsync(
      {
        GH_TOKEN: 'delivery-secret',
        GITHUB_TOKEN: 'delivery-secret',
        AGENT_QUORUM_EXECUTION_CONTROL_FILE: '/guardian-secret',
        FAKE_CODEX_OUTPUT: result,
        FAKE_CODEX_PROMPT: path.join(root, 'prompt'),
        FAKE_CODEX_ARGV_LOG: argv,
        FAKE_CODEX_ATTEMPTS: path.join(root, 'attempts'),
        FAKE_CODEX_FAILS: '2',
      },
      () =>
        providerRun(
          { ...runtime(), binaries: { ...runtime().binaries, codex: wrapper } },
          {
            task: 'delivery-implementation',
            runner: 'codex',
            model: 'fixture-model',
            reasoning: 'high',
            mode: 'json',
            outFile: output,
            skillFile: path.join(SKILLS_DIR, 'plan-creator', 'SKILL.md'),
            schemaFile: path.join(SKILLS_DIR, '_shared', 'markdown.schema.json'),
            promptText: 'fixture task',
            codexConfig: ['features.shell_tool=false'],
            isolatedUserConfig: true,
            execution: {
              beforeSpawn: () => {
                reserved += 1;
              },
              onSpawn: () => {
                started += 1;
              },
            },
          },
        ),
    );
    expect(status).toBe(0);
    const inherited = JSON.parse(readFileSync(envFile, 'utf8')) as NodeJS.ProcessEnv;
    expect(inherited.GH_TOKEN).toBeUndefined();
    expect(inherited.GITHUB_TOKEN).toBeUndefined();
    expect(inherited.AGENT_QUORUM_EXECUTION_CONTROL_FILE).toBeUndefined();
    expect(inherited.NODE_OPTIONS).toBeUndefined();
    expect(inherited.HOME).toBeTruthy();
    expect(reserved).toBe(3);
    expect(started).toBe(3);
    expect(readFileSync(output, 'utf8')).toBe(readFileSync(result, 'utf8'));
    for (const call of argvRecords(argv)) {
      expect(call).toContain('fixture-model');
      expect(call).toContain('--ignore-user-config');
      expect(call).toContain('features.shell_tool=false');
      expect(call).toContain('read-only');
      expect(call).not.toContain('resume');
    }
  });

  it('accounts for nested session recovery before allowing the next outer retry', async () => {
    const result = path.join(root, 'result.md');
    writeFileSync(result, 'recovered');
    const provider = runtime();
    writeFileSync(provider.creatorSessionFile, 'stale-session');
    let calls = 0;
    const status = await withEnvAsync(
      { FAKE_CLAUDE_MARKDOWN_RESULT: result, FAKE_CLAUDE_FAIL_ON_RESUME: '1' },
      () =>
        providerRun(
          {
            ...provider,
            sessionMode: 1,
            matrix: {
              ...provider.matrix,
              creator: { runner: 'claude', model: 'fixture-model', reasoning: 'high' },
            },
            execution: {
              beforeSpawn: () => {
                calls += 1;
              },
            },
          },
          'creator',
          'markdown',
          path.join(root, 'out.md'),
          path.join(SKILLS_DIR, 'plan-creator', 'SKILL.md'),
          '',
          'Read',
          'Write',
          'fixture',
        ),
    );
    expect(status).toBe(0);
    expect(calls).toBe(2);
  });
});
