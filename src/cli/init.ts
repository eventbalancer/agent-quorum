import { createInterface, type Interface } from 'node:readline';
import { randomBytes } from 'node:crypto';
import { HaltError } from '../runtime/halt.js';
import { resolveArtifactRoots } from '../runtime/paths.js';
import { resolveConfig, type DeepPartial, type OperatorConfig } from '../core/config.js';
import { mergeConfigStore, writeSecretsStore } from '../core/store.js';
import { INIT_USAGE } from './help.js';
import {
  telegramDiscoverChatId,
  type TelegramDiscoveryRuntime,
} from '../channels/telegram/index.js';
import type { RunOverrides } from '../types.js';

export interface InitStreams {
  readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly output: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface InitDeps {
  readonly streams?: InitStreams;
  readonly overrides?: RunOverrides;
  // Test seam: replaces the operator action (send the code) after the drain.
  readonly onReady?: (code: string) => void | Promise<void>;
  readonly discoveryTimeoutSeconds?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT_SECONDS = 120;

function ask(rl: Interface, question: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, resolve);
  });
}

export async function runInitCli(args: readonly string[], deps: InitDeps = {}): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    (deps.streams?.output ?? process.stdout).write(INIT_USAGE);
    return 0;
  }

  const streams: InitStreams = deps.streams ?? { input: process.stdin, output: process.stdout };
  if (streams.input.isTTY !== true || streams.output.isTTY !== true) {
    throw new HaltError(
      'agent-quorum init requires an interactive terminal (TTY); set config.json/secrets.json directly in a non-interactive context',
      1,
      true,
    );
  }

  const overrides: RunOverrides = deps.overrides ?? {};
  const { home } = resolveArtifactRoots(overrides);
  const write = (text: string): void => {
    streams.output.write(text);
  };
  const rl = createInterface({ input: streams.input, output: streams.output });
  try {
    write('agent-quorum init — first-run setup\n');
    // Only the token is prompted: sequential readline prompts race with a buffered
    // input chunk, so the rest stays in config.json/env.
    const token = (await ask(rl, 'Telegram bot token: ')).trim();
    if (token === '') {
      throw new HaltError('agent-quorum init: a bot token is required', 1, true);
    }

    const { config: resolved } = resolveConfig({ home, env: process.env });
    const discoveryRuntime: TelegramDiscoveryRuntime = {
      botToken: token,
      apiBase: resolved.telegram.apiBase,
      stateDir: resolved.telegram.stateDir,
    };
    const code = `aq-${randomBytes(4).toString('hex')}`;
    const onReady =
      deps.onReady ??
      ((c: string): void => {
        write(`\nSend this exact message to your bot now: ${c}\n`);
        write('Waiting for the code...\n');
      });
    const chatId = await telegramDiscoverChatId(discoveryRuntime, {
      timeoutSeconds: deps.discoveryTimeoutSeconds ?? DEFAULT_DISCOVERY_TIMEOUT_SECONDS,
      code,
      onReady: () => onReady(code),
      ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    });

    const config: DeepPartial<OperatorConfig> = { telegram: { chatId } };
    mergeConfigStore(home, config);
    writeSecretsStore(home, { telegramBotToken: token });

    write(`\nDiscovered chat id: ${chatId}\n`);
    write(`Saved ${home}/config.json (owner-only home, 0700) and ${home}/secrets.json (0600).\n`);
    return 0;
  } finally {
    rl.close();
  }
}
