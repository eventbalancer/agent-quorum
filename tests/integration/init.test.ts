import {
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
import { ExitCode, runPlanLoop } from '../../src/index.js';
import { runConfigShowCli } from '../../src/cli/config-show.js';
import { runInitCli } from '../../src/cli/init.js';
import { telegramDiscoverChatId } from '../../src/channels/telegram/index.js';
import {
  captureStderr,
  emptyCritique,
  withEnv,
  withEnvAsync,
  writeFakeBin,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';
import { startTelegramStub, type TelegramStub } from '../helpers/telegram-stub.js';

let tmp: string;
let fake: string;
let home: string;
let capture: StderrCapture;

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

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-inittest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
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
      // Stale message carrying the same code, from a different chat, seeded before
      // discovery starts: the drain must fix the offset past it so it never matches.
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

  it('maps a getUpdates 409 (webhook set) to an actionable error', async () => {
    let stub: TelegramStub | undefined;
    try {
      stub = await startTelegramStub('42');
      stub.failNext({ status: 409, errorCode: 409, description: 'webhook is active', times: 1 });
      await expect(
        telegramDiscoverChatId(
          { botToken: 'tok', apiBase: stub.baseUrl },
          { timeoutSeconds: 3, code: 'aq-x', pollIntervalMs: 10, onReady: () => undefined },
        ),
      ).rejects.toThrow(/409/);
    } finally {
      await stub?.close();
    }
  });
});

describe('agent-quorum init', () => {
  it('writes config.json + 0600 secrets.json, discovers the chat id, and a later run notifies from the store', async () => {
    const stub = await startTelegramStub('42');
    try {
      await withEnvAsync(
        { AGENT_QUORUM_HOME: home, AGENT_QUORUM_TELEGRAM_API_BASE: stub.baseUrl },
        async () => {
          const { input, output } = ttyStreams();
          const pending = runInitCli([], {
            streams: { input, output },
            discoveryTimeoutSeconds: 3,
            pollIntervalMs: 10,
            onReady: (code) => {
              stub.queueReply(1, code, { chatId: '42' });
            },
          });
          input.write('BOTTOKEN-123\n');
          const exitCode = await pending;
          expect(exitCode).toBe(0);
        },
      );

      const configFile = path.join(home, 'config.json');
      const secretsFile = path.join(home, 'secrets.json');
      expect(existsSync(configFile)).toBe(true);
      expect(existsSync(secretsFile)).toBe(true);
      expect(JSON.parse(readFileSync(configFile, 'utf8'))).toMatchObject({
        telegram: { chatId: '42' },
      });
      expect(statSync(secretsFile).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(secretsFile, 'utf8'))).toEqual({
        telegramBotToken: 'BOTTOKEN-123',
      });

      // AC-5: a later run notifies using only the store (no env credentials).
      mkdirSync(path.join(tmp, 'work'));
      writeStructuredPlanFile(path.join(tmp, 'input.md'), 'Init Followup');
      emptyCritique(path.join(tmp, 'empty.json'));
      const result = await withEnvAsync(
        {
          PATH: `${fake}:${process.env.PATH ?? ''}`,
          AGENT_QUORUM_HOME: home,
          AGENT_QUORUM_TELEGRAM_API_BASE: stub.baseUrl,
          AGENT_QUORUM_TELEGRAM_BOT_TOKEN: undefined,
          AGENT_QUORUM_TELEGRAM_CHAT_ID: undefined,
          AGENT_QUORUM_WORK_DIR: path.join(tmp, 'work'),
          AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
          AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
          AGENT_QUORUM_CLARIFY: '0',
          AGENT_QUORUM_RETRY_COUNT: '0',
          FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
          FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        },
        () =>
          runPlanLoop({
            input: path.join(tmp, 'input.md'),
            iters: 1,
            effort: 'low',
            fix: false,
            translate: false,
          }),
      );
      expect(result.exitCode).toBe(ExitCode.Ok);
      expect(stub.sent.some((text) => text.includes('agent-quorum finished'))).toBe(true);
    } finally {
      await stub.close();
    }
  });

  it('preserves operator-tuned config keys on re-run and updates only the chat id', async () => {
    const stub = await startTelegramStub('99');
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(
        path.join(home, 'config.json'),
        `${JSON.stringify({
          settings: { iters: 7 },
          telegram: { chatId: 'OLD', clarify: '1' },
          experimentalUnknownKey: { keep: true },
        })}\n`,
      );

      await withEnvAsync(
        { AGENT_QUORUM_HOME: home, AGENT_QUORUM_TELEGRAM_API_BASE: stub.baseUrl },
        async () => {
          const { input, output } = ttyStreams();
          const pending = runInitCli([], {
            streams: { input, output },
            discoveryTimeoutSeconds: 3,
            pollIntervalMs: 10,
            onReady: (code) => {
              stub.queueReply(1, code, { chatId: '99' });
            },
          });
          input.write('BOTTOKEN-rotated\n');
          expect(await pending).toBe(0);
        },
      );

      expect(JSON.parse(readFileSync(path.join(home, 'config.json'), 'utf8'))).toEqual({
        settings: { iters: 7 },
        telegram: { chatId: '99', clarify: '1' },
        experimentalUnknownKey: { keep: true },
      });
    } finally {
      await stub.close();
    }
  });

  it('errors on a non-TTY stdin instead of hanging', async () => {
    const input: PassThrough & { isTTY?: boolean } = new PassThrough();
    const output: PassThrough & { isTTY?: boolean } = new PassThrough();
    output.isTTY = true;
    await expect(runInitCli([], { streams: { input, output } })).rejects.toThrow(/TTY/);
  });
});

describe('agent-quorum config', () => {
  it('prints the winning layer for each source and masks the bot token', () => {
    mkdirSync(home, { recursive: true });
    writeFileSync(
      path.join(home, 'config.json'),
      `${JSON.stringify({ telegram: { chatId: '555' } })}\n`,
    );
    writeFileSync(
      path.join(home, 'secrets.json'),
      `${JSON.stringify({ telegramBotToken: 'TOPSECRET' })}\n`,
      {
        mode: 0o600,
      },
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
    expect(out).toContain('retention.keepCount: env');
    expect(out).toContain('telegram.chatId: store');
    expect(out).toContain('telegram.clarifyDeadlineSeconds: default');
    expect(out).toContain('"botToken": "***"');
    expect(out).not.toContain('TOPSECRET');
  });
});
