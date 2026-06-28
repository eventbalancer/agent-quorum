import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLAN_ROLES, resolveConfig } from '../../src/core/config.js';
import { runConfigShowCli } from '../../src/cli/config-show.js';
import { runSetupCli } from '../../src/cli/setup.js';
import { globalHelp } from '../../src/cli/help.js';
import { telegramDiscoverChatId } from '../../src/channels/telegram/index.js';
import type { Role } from '../../src/types.js';
import { captureStderr, withEnv, withEnvAsync, type StderrCapture } from '../helpers/harness.js';
import { runCli } from '../helpers/cli.js';
import { startTelegramStub, type TelegramStub } from '../helpers/telegram-stub.js';

let tmp: string;
let bin: string;
let home: string;
let capture: StderrCapture;

const STAGE_SUMMARIES = [{ name: 'plan', summary: 'iterate plan' }];

function ttyStreams(): {
  input: PassThrough & { isTTY?: boolean };
  output: PassThrough & { isTTY?: boolean };
} {
  const input: PassThrough & { isTTY?: boolean } = new PassThrough();
  const output: PassThrough & { isTTY?: boolean } = new PassThrough();
  input.isTTY = true;
  output.isTTY = true;
  return { input, output };
}

function pipeStreams(): {
  input: PassThrough & { isTTY?: boolean };
  output: PassThrough & { isTTY?: boolean };
} {
  return { input: new PassThrough(), output: new PassThrough() };
}

function collect(output: PassThrough): { text: () => string } {
  let buffer = '';
  output.on('data', (chunk: Buffer) => {
    buffer += chunk.toString();
  });
  return { text: () => buffer };
}

// Make exactly the named runner binaries resolvable on PATH so detection is
// deterministic regardless of what is installed on the host.
function installRunnerBins(dir: string, bins: readonly string[]): void {
  mkdirSync(dir, { recursive: true });
  for (const name of bins) {
    const target = path.join(dir, name);
    writeFileSync(target, '#!/bin/sh\nexit 0\n');
    chmodSync(target, 0o755);
  }
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-setuptest.'));
  bin = path.join(tmp, 'bin');
  home = path.join(tmp, 'home');
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('telegramDiscoverChatId', () => {
  it('ignores a stale same-code message and returns the coded message chat (high-water drain)', async () => {
    let stub: TelegramStub | undefined;
    try {
      stub = await startTelegramStub('42');
      const code = 'aq-stale-vs-fresh';
      stub.queueReply(1, code, { chatId: '999' });
      const chatId = await telegramDiscoverChatId(
        { botToken: 'tok', apiBase: stub.baseUrl },
        {
          timeoutSeconds: 3,
          code,
          pollIntervalMs: 10,
          onReady: () => stub?.queueReply(2, code, { chatId: '42' }),
        },
      );
      expect(chatId).toBe('42');
    } finally {
      await stub?.close();
    }
  });

  it('captures a coded message that arrives immediately after the onReady prompt', async () => {
    let stub: TelegramStub | undefined;
    try {
      stub = await startTelegramStub('77');
      const code = 'aq-immediate';
      const chatId = await telegramDiscoverChatId(
        { botToken: 'tok', apiBase: stub.baseUrl },
        {
          timeoutSeconds: 3,
          code,
          pollIntervalMs: 10,
          onReady: () => stub?.queueReply(1, code, { chatId: '77' }),
        },
      );
      expect(chatId).toBe('77');
    } finally {
      await stub?.close();
    }
  });

  it('maps a getUpdates 409 (webhook set) to an actionable error naming setup', async () => {
    let stub: TelegramStub | undefined;
    try {
      stub = await startTelegramStub('42');
      stub.failNext({
        status: 409,
        errorCode: 409,
        description: 'webhook is active',
        times: 1,
      });
      await expect(
        telegramDiscoverChatId(
          { botToken: 'tok', apiBase: stub.baseUrl },
          { timeoutSeconds: 3, code: 'aq-x', pollIntervalMs: 10, onReady: () => undefined },
        ),
      ).rejects.toThrow(/before running setup/);
    } finally {
      await stub?.close();
    }
  });
});

describe('agent-quorum setup — interactive', () => {
  // Answers map positionally to setup.ts's prompt order: 4 globals, one per
  // PLAN_ROLES role in list order, then the token.
  interface InteractiveAnswers {
    readonly iters?: string;
    readonly quality?: string;
    readonly locale?: string;
    readonly translate?: string;
    readonly token?: string;
    readonly roleRunners?: Partial<Record<Role, string>>;
  }

  const GLOBAL_PROMPTS = 4;
  const INTERACTIVE_PROMPTS = GLOBAL_PROMPTS + PLAN_ROLES.length + 1;

  function answerSequence(spec: InteractiveAnswers): string[] {
    return [
      spec.iters ?? '',
      spec.quality ?? '',
      spec.locale ?? '',
      spec.translate ?? '',
      ...PLAN_ROLES.map((role) => spec.roleRunners?.[role] ?? ''),
      spec.token ?? '',
    ];
  }

  function feedRaw(input: PassThrough, lines: readonly string[]): number {
    input.write(lines.map((line) => `${line}\n`).join(''));
    return lines.length;
  }

  function feed(input: PassThrough, spec: InteractiveAnswers): number {
    return feedRaw(input, answerSequence(spec));
  }

  const GUARD_MS = 4000;

  function expectSetupCompletes(pending: Promise<number>, emitted: number): Promise<number> {
    let timer!: ReturnType<typeof setTimeout>;
    const guard = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        reject(
          new Error(
            `setup did not complete: fed ${emitted} answers but expected ${INTERACTIVE_PROMPTS} interactive prompts (${GLOBAL_PROMPTS} global + ${PLAN_ROLES.length} roles + 1 token)`,
          ),
        );
      }, GUARD_MS);
      timer.unref();
    });
    return Promise.race([pending, guard]).finally(() => {
      clearTimeout(timer);
    });
  }

  it('derives answer count and per-role slots from PLAN_ROLES', () => {
    expect(answerSequence({}).length).toBe(INTERACTIVE_PROMPTS);
    PLAN_ROLES.forEach((role, roleIndex) => {
      const roleRunners: Partial<Record<Role, string>> = { [role]: 'X' };
      const sequence = answerSequence({ roleRunners });
      sequence.forEach((line, slot) => {
        expect(line).toBe(slot === GLOBAL_PROMPTS + roleIndex ? 'X' : '');
      });
    });
  });

  it('AC-1: completes on a fresh home and re-enters cleanly on a re-run', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      for (let run = 0; run < 2; run += 1) {
        const { input, output } = ttyStreams();
        const pending = runSetupCli([], { streams: { input, output } });
        const fed = feed(input, {});
        expect(await expectSetupCompletes(pending, fed)).toBe(0);
      }
    });
    expect(existsSync(path.join(home, 'config.json'))).toBe(true);
  });

  it('AC-2: writes only essentials + Telegram (no advanced section)', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    const stub = await startTelegramStub('42');
    try {
      await withEnvAsync(
        { PATH: bin, AGENT_QUORUM_HOME: home, AGENT_QUORUM_TELEGRAM_API_BASE: stub.baseUrl },
        async () => {
          const { input, output } = ttyStreams();
          const pending = runSetupCli([], {
            streams: { input, output },
            discoveryTimeoutSeconds: 3,
            pollIntervalMs: 10,
            onReady: (code) => {
              stub.queueReply(1, code, { chatId: '42' });
            },
          });
          const fed = feed(input, { iters: '7', token: 'BOTTOKEN-1' });
          expect(await expectSetupCompletes(pending, fed)).toBe(0);
        },
      );
      expect(readConfig()).toEqual({ settings: { iters: 7 }, telegram: { chatId: '42' } });
      const secretsFile = path.join(home, 'secrets.json');
      expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(secretsFile, 'utf8'))).toEqual({
        telegramBotToken: 'BOTTOKEN-1',
      });
    } finally {
      await stub.close();
    }
  });

  it('AC-3: declining Telegram completes with essentials and writes no token', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      const { input, output } = ttyStreams();
      const pending = runSetupCli([], { streams: { input, output } });
      const fed = feed(input, { iters: '3' });
      expect(await expectSetupCompletes(pending, fed)).toBe(0);
    });
    expect(readConfig()).toEqual({ settings: { iters: 3 } });
    expect(existsSync(path.join(home, 'secrets.json'))).toBe(false);
  });

  it('AC-5: a per-role runner override is reflected in the saved config', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      const { input, output } = ttyStreams();
      const pending = runSetupCli([], { streams: { input, output } });
      const fed = feed(input, { roleRunners: { critic: 'claude' } });
      expect(await expectSetupCompletes(pending, fed)).toBe(0);
    });
    expect(readConfig()).toEqual({
      roles: { critic: { runner: 'claude', model: 'claude-opus-4-8' } },
    });
  });

  it('AC-7: a re-run accepting defaults leaves hand-edited advanced and unknown keys intact', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    mkdirSync(home, { recursive: true });
    const seeded = {
      settings: { iters: 7, retryCount: 9 },
      knobs: { claude: { stallPollSeconds: 11 } },
      experimentalUnknownKey: { keep: true },
    };
    writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(seeded)}\n`);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      const { input, output } = ttyStreams();
      const pending = runSetupCli([], { streams: { input, output } });
      const fed = feed(input, {});
      expect(await expectSetupCompletes(pending, fed)).toBe(0);
    });
    expect(readConfig()).toEqual(seeded);
  });

  it('AC-13: a re-run preserves an installed non-default role-runner override', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    mkdirSync(home, { recursive: true });
    const seeded = { roles: { critic: { runner: 'claude', model: 'custom-model' } } };
    writeFileSync(path.join(home, 'config.json'), `${JSON.stringify(seeded)}\n`);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      const { input, output } = ttyStreams();
      const pending = runSetupCli([], { streams: { input, output } });
      const fed = feed(input, {});
      expect(await expectSetupCompletes(pending, fed)).toBe(0);
    });
    expect(readConfig()).toEqual(seeded);
  });

  it('AC-14 (interactive): a non-English locale with translation disabled persists translate=false', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      const { input, output } = ttyStreams();
      const pending = runSetupCli([], { streams: { input, output } });
      const fed = feed(input, { locale: 'ru', translate: 'no' });
      expect(await expectSetupCompletes(pending, fed)).toBe(0);
    });
    expect(readConfig()).toEqual({ settings: { locale: 'ru', translate: false } });
    const { config } = resolveConfig({ home, env: {} });
    expect(config.settings.translatePass).toBe(0);
    expect(config.settings.locale).toBe('ru');
  });

  it('fails fast naming the emitted count when answers underfill the prompts', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      const { input, output } = ttyStreams();
      const pending = runSetupCli([], { streams: { input, output } });
      const emitted = feedRaw(input, ['', '', '', '']);
      await expect(expectSetupCompletes(pending, emitted)).rejects.toThrow(
        /fed 4 answers but expected/,
      );
      feedRaw(input, [...PLAN_ROLES.map(() => ''), '']);
      expect(await pending).toBe(0);
    });
  });
});

describe('agent-quorum setup — non-TTY', () => {
  it('AC-4: a single installed runner resolves every role to it', async () => {
    installRunnerBins(bin, ['codex']);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      const { input, output } = pipeStreams();
      expect(await runSetupCli([], { streams: { input, output } })).toBe(0);
    });
    const { config } = resolveConfig({ home, env: {} });
    for (const role of PLAN_ROLES) {
      expect(config.matrix[role].runner).toBe('codex');
    }
  });

  it('AC-6: no installed runner warns, writes essentials, and leaves roles default', async () => {
    installRunnerBins(bin, []);
    const out = (() => {
      const { input, output } = pipeStreams();
      const sink = collect(output);
      return { input, output, sink };
    })();
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      expect(
        await runSetupCli(['--iters', '9'], { streams: { input: out.input, output: out.output } }),
      ).toBe(0);
    });
    expect(readConfig()).toEqual({ settings: { iters: 9 } });
    expect(out.sink.text()).toContain('no supported runner detected');
  });

  it('AC-8: non-TTY flags apply without blocking', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      const { input, output } = pipeStreams();
      expect(
        await runSetupCli(
          ['--iters', '9', '--quality', 'thorough', '--locale', 'de', '--no-translate'],
          { streams: { input, output } },
        ),
      ).toBe(0);
    });
    expect(readConfig()).toEqual({
      settings: {
        iters: 9,
        quality: 'thorough',
        locale: 'de',
        translate: false,
      },
    });
  });

  it('AC-14 (non-TTY): --locale <non-en> --no-translate persists translate=false', async () => {
    installRunnerBins(bin, ['codex', 'claude']);
    await withEnvAsync({ PATH: bin, AGENT_QUORUM_HOME: home }, async () => {
      const { input, output } = pipeStreams();
      expect(
        await runSetupCli(['--locale', 'ru', '--no-translate'], { streams: { input, output } }),
      ).toBe(0);
    });
    expect(readConfig()).toEqual({ settings: { locale: 'ru', translate: false } });
    const { config } = resolveConfig({ home, env: {} });
    expect(config.settings.translatePass).toBe(0);
  });
});

describe('agent-quorum command surface', () => {
  it('AC-1: `init` is no longer a command', () => {
    const result = runCli(['init'], { AGENT_QUORUM_HOME: home });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("unknown command 'init'");
  });

  it('global help advertises setup, not init', () => {
    const help = globalHelp(STAGE_SUMMARIES);
    expect(help).toContain('setup       guided configuration');
    expect(help).not.toContain('init        interactive');
  });
});

describe('agent-quorum config', () => {
  it('prints the winning layer for each source, the quality dial, and masks the bot token', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, 'config.json'),
      `${JSON.stringify({ telegram: { chatId: '555' } })}\n`,
    );
    writeFileSync(
      path.join(home, 'secrets.json'),
      `${JSON.stringify({ telegramBotToken: 'TOPSECRET' })}\n`,
      { mode: 0o600 },
    );

    let out = '';
    const exitCode = withEnv(
      {
        AGENT_QUORUM_HOME: home,
        AGENT_QUORUM_RETAIN_COUNT: '9',
        AGENT_QUORUM_TELEGRAM_BOT_TOKEN: undefined,
        AGENT_QUORUM_TELEGRAM_API_BASE: undefined,
      },
      () =>
        runConfigShowCli(['--locale', 'fr-FR'], (text) => {
          out += text;
        }),
    );

    expect(exitCode).toBe(0);
    expect(out).toContain('settings.locale: override');
    expect(out).toContain('telegram.chatId: store');
    expect(out).toContain('"quality": "balanced"');
    expect(out).not.toContain('"effort"');
    expect(out).toContain('"botToken": "***"');
    expect(out).not.toContain('TOPSECRET');
  });
});
