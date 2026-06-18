import { randomBytes } from 'node:crypto';
import { HaltError } from '../runtime/halt.js';
import { resolveArtifactRoots } from '../runtime/paths.js';
import {
  localeNeedsTranslation,
  normalizeLocale,
  PLAN_ROLES,
  resolveConfig,
  type DeepPartial,
  type OperatorConfig,
  type OperatorRoles,
  type OperatorSettings,
  type ResolvedConfig,
} from '../core/config.js';
import { formatQualityHint, isQuality } from '../core/quality.js';
import { mergeConfigStore, writeSecretsStore } from '../core/store.js';
import { detectInstalledRunners } from '../core/runner-detect.js';
import { RUNNER_META, RUNNERS, isRunner, resolveRunnerBinaries } from '../providers/registry.js';
import { SETUP_USAGE } from './help.js';
import {
  telegramDiscoverChatId,
  type TelegramDiscoveryRuntime,
} from '../channels/telegram/index.js';
import type { Quality, Role, Runner, RunOverrides } from '../types.js';

export interface SetupStreams {
  readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly output: NodeJS.WritableStream & { isTTY?: boolean };
}

export interface SetupDeps {
  readonly streams?: SetupStreams;
  readonly overrides?: RunOverrides;
  readonly onReady?: (code: string) => void | Promise<void>;
  readonly discoveryTimeoutSeconds?: number;
  readonly pollIntervalMs?: number;
}

const DEFAULT_DISCOVERY_TIMEOUT_SECONDS = 120;

function assertSetupQuality(raw: string, exitCode: 1 | 2): asserts raw is Quality {
  if (!isQuality(raw)) {
    throw new HaltError(
      `agent-quorum setup: quality must be ${formatQualityHint()} (got '${raw}')`,
      exitCode,
      true,
    );
  }
}

interface SetupAnswers {
  iters?: number;
  quality?: Quality;
  locale?: string;
  translate?: boolean;
  roleRunners: Partial<Record<Role, Runner>>;
}

function parsePositiveInt(raw: string, label: string): number {
  if (!/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
    throw new HaltError(
      `agent-quorum setup: ${label} must be a positive integer (got '${raw}')`,
      1,
      true,
    );
  }
  return Number(raw);
}

function parseYesNo(raw: string, label: string): boolean {
  const value = raw.trim().toLowerCase();
  if (value === 'y' || value === 'yes' || value === 'true' || value === 'on' || value === '1') {
    return true;
  }
  if (value === 'n' || value === 'no' || value === 'false' || value === 'off' || value === '0') {
    return false;
  }
  throw new HaltError(`agent-quorum setup: ${label} must be yes or no (got '${raw}')`, 1, true);
}

function fallbackRunners(
  resolved: ResolvedConfig,
  installed: readonly Runner[],
): Record<Role, Runner> | undefined {
  const primary = installed[0];
  if (primary === undefined) {
    return undefined;
  }
  const assignment = {} as Record<Role, Runner>;
  for (const role of PLAN_ROLES) {
    const current = resolved.matrix[role].runner;
    assignment[role] = installed.includes(current) ? current : primary;
  }
  return assignment;
}

function shouldPersistTranslateChoice(selectedLocale: string, chosenTranslate: boolean): boolean {
  return chosenTranslate !== localeNeedsTranslation(selectedLocale);
}

function buildPatch(resolved: ResolvedConfig, answers: SetupAnswers): DeepPartial<OperatorConfig> {
  const settings: DeepPartial<OperatorSettings> = {};
  if (answers.iters !== undefined && answers.iters !== resolved.settings.maxIters) {
    settings.iters = answers.iters;
  }
  if (answers.quality !== undefined && answers.quality !== resolved.settings.quality) {
    settings.quality = answers.quality;
  }
  const selectedLocale = answers.locale ?? resolved.settings.locale;
  if (answers.locale !== undefined && answers.locale !== resolved.settings.locale) {
    settings.locale = answers.locale;
  }
  const chosenTranslate = answers.translate ?? resolved.settings.translatePass === 1;
  if (shouldPersistTranslateChoice(selectedLocale, chosenTranslate)) {
    settings.translate = chosenTranslate;
  }

  const roles: DeepPartial<OperatorRoles> = {};
  for (const role of PLAN_ROLES) {
    const runner = answers.roleRunners[role];
    if (runner !== undefined && runner !== resolved.matrix[role].runner) {
      roles[role] = { runner, model: RUNNER_META[runner].defaultModel };
    }
  }

  const patch: DeepPartial<OperatorConfig> = {};
  if (Object.keys(settings).length > 0) {
    patch.settings = settings;
  }
  if (Object.keys(roles).length > 0) {
    patch.roles = roles;
  }
  return patch;
}

function parseNonTtyArgs(args: readonly string[]): SetupAnswers {
  const answers: SetupAnswers = { roleRunners: {} };
  let i = 0;
  const need = (flag: string): string => {
    const value = args[i + 1] ?? '';
    if (value === '') {
      throw new HaltError(`agent-quorum setup: ${flag} needs a value`, 2, true);
    }
    return value;
  };
  while (i < args.length) {
    const arg = args[i] ?? '';
    switch (true) {
      case arg === '--iters' || arg === '--max-iters':
        answers.iters = parsePositiveInt(need(arg), 'iters');
        i += 2;
        break;
      case arg.startsWith('--iters=') || arg.startsWith('--max-iters='):
        answers.iters = parsePositiveInt(arg.slice(arg.indexOf('=') + 1), 'iters');
        i += 1;
        break;
      case arg === '--quality': {
        const raw = need('--quality');
        assertSetupQuality(raw, 2);
        answers.quality = raw;
        i += 2;
        break;
      }
      case arg.startsWith('--quality='): {
        const raw = arg.slice('--quality='.length);
        assertSetupQuality(raw, 2);
        answers.quality = raw;
        i += 1;
        break;
      }
      case arg === '--locale':
        answers.locale = normalizeLocale(need('--locale'));
        i += 2;
        break;
      case arg.startsWith('--locale='):
        answers.locale = normalizeLocale(arg.slice('--locale='.length));
        i += 1;
        break;
      case arg === '--translate':
        answers.translate = true;
        i += 1;
        break;
      case arg === '--no-translate':
        answers.translate = false;
        i += 1;
        break;
      default:
        throw new HaltError(`agent-quorum setup: unknown flag: ${arg}`, 2, true);
    }
  }
  return answers;
}

function autoAssignRoles(
  answers: SetupAnswers,
  resolved: ResolvedConfig,
  installed: readonly Runner[],
  warn: (text: string) => void,
): void {
  const assignment = fallbackRunners(resolved, installed);
  if (assignment === undefined) {
    warnNoRunner(warn);
    return;
  }
  for (const role of PLAN_ROLES) {
    answers.roleRunners[role] = assignment[role];
  }
}

function warnNoRunner(warn: (text: string) => void): void {
  warn(
    'no supported runner detected; leaving role runners unchanged. Install and authenticate one:\n',
  );
  for (const runner of RUNNERS) {
    warn(`  - ${runner}: ${RUNNER_META[runner].auth.remedy(RUNNER_META[runner].binary.default)}\n`);
  }
}

interface LineReader {
  ask(question: string): Promise<string>;
  dispose(): void;
}

// Read whole lines directly off the input stream rather than through readline:
// setup asks several prompts in a row, and readline's per-question handler can
// drop a line when all answers arrive in one buffered chunk (the single-prompt
// limitation the old `init` deliberately worked around). Buffering every parsed
// line here keeps prompt order deterministic regardless of arrival timing.
function createLineReader(input: NodeJS.ReadableStream, write: (text: string) => void): LineReader {
  let buffer = '';
  const queued: string[] = [];
  const waiters: ((line: string) => void)[] = [];
  const onData = (chunk: Buffer | string): void => {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(line);
      } else {
        queued.push(line);
      }
    }
  };
  input.on('data', onData);
  input.resume();
  return {
    ask(question: string): Promise<string> {
      write(question);
      const line = queued.shift();
      if (line !== undefined) {
        return Promise.resolve(line);
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
    dispose(): void {
      input.removeListener('data', onData);
      input.pause();
    },
  };
}

async function runInteractive(
  streams: SetupStreams,
  resolved: ResolvedConfig,
  installed: readonly Runner[],
): Promise<{ answers: SetupAnswers; token: string }> {
  const write = (text: string): void => {
    streams.output.write(text);
  };
  const reader = createLineReader(streams.input, write);
  try {
    const answers: SetupAnswers = { roleRunners: {} };

    const itersRaw = (await reader.ask(`iters [${resolved.settings.maxIters}]: `)).trim();
    if (itersRaw !== '') {
      answers.iters = parsePositiveInt(itersRaw, 'iters');
    }

    const qualityRaw = (
      await reader.ask(`quality (quick|balanced|thorough) [${resolved.settings.quality}]: `)
    ).trim();
    if (qualityRaw !== '') {
      assertSetupQuality(qualityRaw, 1);
      answers.quality = qualityRaw;
    }

    const localeRaw = (await reader.ask(`locale [${resolved.settings.locale}]: `)).trim();
    if (localeRaw !== '') {
      answers.locale = normalizeLocale(localeRaw);
    }

    const translateDefault = resolved.settings.translatePass === 1 ? 'yes' : 'no';
    const translateRaw = (await reader.ask(`translate (yes|no) [${translateDefault}]: `)).trim();
    if (translateRaw !== '') {
      answers.translate = parseYesNo(translateRaw, 'translate');
    }

    const assignment = fallbackRunners(resolved, installed);
    if (assignment === undefined) {
      warnNoRunner(write);
    } else {
      const options = installed.join(', ');
      for (const role of PLAN_ROLES) {
        const proposed = assignment[role];
        const choiceRaw = (await reader.ask(`${role} runner (${options}) [${proposed}]: `)).trim();
        const runner = choiceRaw === '' ? proposed : choiceRaw;
        if (!isRunner(runner)) {
          throw new HaltError(
            `agent-quorum setup: '${role}' runner must be one of ${RUNNERS.join(', ')} (got '${runner}')`,
            1,
            true,
          );
        }
        answers.roleRunners[role] = runner;
      }
    }

    const token = (await reader.ask('Telegram bot token (leave blank to skip): ')).trim();
    return { answers, token };
  } finally {
    reader.dispose();
  }
}

export async function runSetupCli(args: readonly string[], deps: SetupDeps = {}): Promise<number> {
  if (args.includes('-h') || args.includes('--help')) {
    (deps.streams?.output ?? process.stdout).write(SETUP_USAGE);
    return 0;
  }

  const overrides: RunOverrides = deps.overrides ?? {};
  const { home } = resolveArtifactRoots(overrides);
  const { config: resolved } = resolveConfig({ home, env: process.env });
  const binaries = resolveRunnerBinaries();
  const installed = detectInstalledRunners(binaries);

  const streams: SetupStreams = deps.streams ?? { input: process.stdin, output: process.stdout };
  const interactive = streams.input.isTTY === true && streams.output.isTTY === true;

  if (!interactive) {
    const answers = parseNonTtyArgs(args);
    autoAssignRoles(answers, resolved, installed, (text) => {
      streams.output.write(text);
    });
    mergeConfigStore(home, buildPatch(resolved, answers));
    streams.output.write(`Saved ${home}/config.json.\n`);
    return 0;
  }

  const write = (text: string): void => {
    streams.output.write(text);
  };
  write('agent-quorum setup — guided configuration\n');
  const { answers, token } = await runInteractive(streams, resolved, installed);

  const patch = buildPatch(resolved, answers);

  if (token !== '') {
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
      onReady: () => {
        return onReady(code);
      },
      ...(deps.pollIntervalMs !== undefined ? { pollIntervalMs: deps.pollIntervalMs } : {}),
    });
    patch.telegram = { chatId };
    write(`\nDiscovered chat id: ${chatId}\n`);
  }

  mergeConfigStore(home, patch);
  if (token !== '') {
    writeSecretsStore(home, { telegramBotToken: token });
    write(`Saved ${home}/config.json and ${home}/secrets.json (0600).\n`);
  } else {
    write(`Saved ${home}/config.json.\n`);
  }
  return 0;
}
