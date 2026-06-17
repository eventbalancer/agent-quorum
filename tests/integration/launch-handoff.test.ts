import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// vi.spyOn cannot intercept the ESM `spawn` named import (the module namespace is
// not configurable), so the launch-side handoff is asserted by mocking the module
// with a fake spawn that records the child env/args and reports the test process
// as the (live) child pid, keeping the owner-only handoff file in place for
// inspection instead of letting a real detached child read and unlink it.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return { ...actual, spawn: spawnMock };
});

import { runLaunchCli } from '../../src/cli/launch.js';
import { launchPlanLoop } from '../../src/index.js';
import { withEnvAsync, writeStructuredPlanFile } from '../helpers/harness.js';

let tmp: string;
let input: string;
let home: string;
let work: string;

function lastSpawn(): { command: string; args: readonly string[]; env: NodeJS.ProcessEnv } {
  expect(spawnMock).toHaveBeenCalledTimes(1);
  const call = spawnMock.mock.calls[0] as [string, string[], { env: NodeJS.ProcessEnv }];
  return { command: call[0], args: call[1], env: call[2].env };
}

function envValues(env: NodeJS.ProcessEnv): string[] {
  return Object.values(env).filter((value): value is string => typeof value === 'string');
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-handoff.'));
  input = path.join(tmp, 'input.md');
  writeStructuredPlanFile(input, 'Launch Handoff');
  home = path.join(tmp, 'home');
  work = path.join(tmp, 'work');
  mkdirSync(work, { recursive: true });
  spawnMock.mockReset();
  spawnMock.mockReturnValue({ pid: process.pid, unref: () => undefined });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('launch secret handoff (P5)', () => {
  it('forwards config as child-env JSON and a structured token as a 0600 handoff file path', async () => {
    await withEnvAsync(
      {
        AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0',
        AGENT_QUORUM_HOME: home,
        AGENT_QUORUM_TELEGRAM_BOT_TOKEN: undefined,
      },
      () =>
        runLaunchCli([input], () => undefined, {
          home,
          workDir: work,
          config: { telegram: { chatId: '5' } },
          secrets: { telegramBotToken: 'TOK-STRUCT' },
        }),
    );

    const { env } = lastSpawn();
    expect(env.AGENT_QUORUM_SECRETS_OVERRIDE_JSON).toBeUndefined();
    expect(env.AGENT_QUORUM_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(JSON.parse(env.AGENT_QUORUM_CONFIG_OVERRIDE_JSON ?? '{}')).toEqual({
      telegram: { chatId: '5' },
    });

    const handoff = env.AGENT_QUORUM_SECRETS_OVERRIDE_FILE ?? '';
    expect(path.dirname(handoff)).toBe(path.join(env.AGENT_QUORUM_HOME ?? '', 'handoff'));
    expect(existsSync(handoff)).toBe(true);
    expect(statSync(handoff).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(handoff, 'utf8'))).toEqual({ telegramBotToken: 'TOK-STRUCT' });
    expect(envValues(env).some((value) => value.includes('TOK-STRUCT'))).toBe(false);
  });

  it('routes an ambient bot token through the handoff file and strips it from the child env', async () => {
    await withEnvAsync(
      {
        AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0',
        AGENT_QUORUM_HOME: home,
        AGENT_QUORUM_TELEGRAM_BOT_TOKEN: 'TOK-AMBIENT',
      },
      async () => {
        await runLaunchCli([input], () => undefined, { home, workDir: work });
        // The parent's ambient token is read, not mutated.
        expect(process.env.AGENT_QUORUM_TELEGRAM_BOT_TOKEN).toBe('TOK-AMBIENT');
      },
    );

    const { env } = lastSpawn();
    expect(env.AGENT_QUORUM_TELEGRAM_BOT_TOKEN).toBeUndefined();
    const handoff = env.AGENT_QUORUM_SECRETS_OVERRIDE_FILE ?? '';
    expect(existsSync(handoff)).toBe(true);
    expect(statSync(handoff).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(handoff, 'utf8'))).toEqual({ telegramBotToken: 'TOK-AMBIENT' });
    expect(envValues(env).some((value) => value.includes('TOK-AMBIENT'))).toBe(false);
  });

  it('writes no handoff file when no token is supplied (store-only token stays on disk)', async () => {
    await withEnvAsync(
      {
        AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0',
        AGENT_QUORUM_HOME: home,
        AGENT_QUORUM_TELEGRAM_BOT_TOKEN: undefined,
      },
      () => runLaunchCli([input], () => undefined, { home, workDir: work }),
    );

    const { env } = lastSpawn();
    expect(env.AGENT_QUORUM_SECRETS_OVERRIDE_FILE).toBeUndefined();
    expect(existsSync(path.join(env.AGENT_QUORUM_HOME ?? '', 'handoff'))).toBe(false);
  });

  it('forwards a top-level scalar ahead of structured config across the launch boundary', async () => {
    await withEnvAsync(
      {
        AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0',
        AGENT_QUORUM_HOME: home,
        AGENT_QUORUM_TELEGRAM_BOT_TOKEN: undefined,
      },
      () =>
        launchPlanLoop({
          input,
          iters: 1,
          effort: 'low',
          fix: false,
          translate: false,
          config: { settings: { iters: 9 } },
        }),
    );

    const { args, env } = lastSpawn();
    const itersIdx = args.indexOf('--iters');
    expect(itersIdx).toBeGreaterThanOrEqual(0);
    expect(args[itersIdx + 1]).toBe('1');
    expect(JSON.parse(env.AGENT_QUORUM_CONFIG_OVERRIDE_JSON ?? '{}')).toEqual({
      settings: { iters: 9 },
    });
  });
});
