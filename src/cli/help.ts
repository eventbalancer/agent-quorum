import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../runtime/env.js';
import { resolveArtifactRoots } from '../runtime/paths.js';
import { DEFAULT_CONFIG } from '../core/defaults.js';
import { readConfigStore } from '../core/store.js';
import { isJsonObject, type JsonValue } from '../core/json.js';

export interface StageSummary {
  readonly name: string;
  readonly summary: string;
}

export const LAUNCH_USAGE =
  'usage: agent-quorum launch [--resume] [--iters N] [--effort {low,high,max}] [--prompt] [--no-fix] [--locale LOCALE] [--no-translate] <input.md>\n';

export const INTERVENE_USAGE =
  'usage: agent-quorum intervene --work <workdir> [--target all|critic|creator|fixer|reviewer] <message...>\n' +
  '       agent-quorum intervene <name|id|PID|--last|--id ID|--name NAME> [--target ...] <message...>\n' +
  '       agent-quorum intervene (--work <workdir> | <selector>) [--target ...] --stdin\n';

export const STATUS_USAGE =
  'agent-quorum status — show progress of an agent-quorum run.\n' +
  '\n' +
  'Usage:\n' +
  '  agent-quorum status <PID>          — any PID in the run’s process tree (main or child)\n' +
  '  agent-quorum status                — list runs (interactive picker in a TTY)\n' +
  '  agent-quorum status --store <dir>  — list only that ledger store (e.g. .agents/plans/.runs)\n' +
  '  agent-quorum status --watch [sel]  — re-render until the run ends (one snapshot non-TTY)\n';

export const PRUNE_USAGE =
  'agent-quorum prune — bound the run ledger (records only; workdirs are never deleted).\n' +
  '\n' +
  'Usage:\n' +
  '  agent-quorum prune [--keep N] [--max-age DAYS] [--dry-run]\n';

export const SHOW_USAGE =
  'agent-quorum show <selector> — print a run’s artifact paths and state.\n' +
  '\n' +
  'Usage:\n' +
  '  agent-quorum show <name|id|PID>   — resolve a run and print workdir/plan/summary/log\n' +
  '  agent-quorum show --last          — the most recent run\n' +
  '  agent-quorum show --work <dir>    — an explicit workdir\n';

export const LOGS_USAGE =
  'agent-quorum logs <selector> [-f] — print or follow a run’s run.log.\n' +
  '\n' +
  'Usage:\n' +
  '  agent-quorum logs <name|id|PID>      — print run.log\n' +
  '  agent-quorum logs <selector> -f      — follow until the run ends\n' +
  '  agent-quorum logs --last [-f]        — the most recent run\n' +
  '  agent-quorum logs --work <dir> [-f]  — an explicit workdir\n';

export const INIT_USAGE =
  'agent-quorum init — interactive first-run setup (TTY only).\n' +
  'Captures the Telegram bot token, discovers the chat id, and writes\n' +
  'config.json + secrets.json (0600) under the agent-quorum home.\n';

export const CONFIG_USAGE =
  "agent-quorum config — print the resolved configuration and each value's winning layer.\n" +
  '\n' +
  'Usage:\n' +
  '  agent-quorum config [--iters N] [--effort E] [--locale L] [--fix|--no-fix] [--translate|--no-translate]\n' +
  '\n' +
  'Scalar flags resolve in the override layer, so they show how a per-invocation\n' +
  'flag would win over env, store, and default. The bot token is never printed.\n';

export function packageVersion(): string {
  const parsed = JSON.parse(
    readFileSync(path.join(packageRoot(), 'package.json'), 'utf8'),
  ) as JsonValue;
  const version = isJsonObject(parsed) ? parsed.version : undefined;
  return typeof version === 'string' ? version : '0.0.0';
}

function settingText(value: JsonValue | undefined): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'boolean') {
    return value ? 'on' : 'off';
  }
  return undefined;
}

// A malformed store must not break --help, so any failure omits the defaults line.
function defaultsLine(): string {
  let settings: Record<string, JsonValue | undefined>;
  try {
    const home = resolveArtifactRoots().home;
    const store = readConfigStore(home).settings ?? {};
    settings = { ...DEFAULT_CONFIG.settings, ...store };
  } catch {
    return '';
  }
  const parts: string[] = [];
  for (const key of ['iters', 'effort', 'fix', 'locale', 'translate']) {
    const text = settingText(settings[key]);
    if (text !== undefined && text !== '') {
      parts.push(`${key}=${text}`);
    }
  }
  if (parts.length === 0) {
    return '';
  }
  return `\ndefaults: ${parts.join(' ')} (from agent-quorum config store)\n`;
}

export function globalHelp(stages: readonly StageSummary[]): string {
  const stageLines = stages
    .map((stage) => `  ${stage.name.padEnd(11)} ${stage.summary}`)
    .join('\n');
  return (
    'usage: agent-quorum <command> [options]\n' +
    '\n' +
    'stages:\n' +
    `${stageLines}\n` +
    '\n' +
    'run-lifecycle commands:\n' +
    '  launch      detach a run into its own process group with run.log redirection\n' +
    '  status      show progress of running agent-quorum runs (--watch to follow)\n' +
    '  show        print a run’s artifact paths (resolve by name/id/PID/--last/--work)\n' +
    '  logs        print or follow a run’s run.log\n' +
    '  prune       remove terminal run records beyond the retention bound\n' +
    '  intervene   append an operator intervention to a run’s ledger\n' +
    '\n' +
    'configuration:\n' +
    '  init        interactive first-run setup: capture the bot token, discover the chat id, write the store\n' +
    '  config      print the resolved configuration and each value’s winning layer (token masked)\n' +
    '\n' +
    'in a TTY, run agent-quorum with no command to open the interactive shell.\n' +
    '\n' +
    'agent-quorum <command> --help prints command-specific usage.\n' +
    'agent-quorum --version (or -V, as the first argument) prints the package version.\n' +
    defaultsLine()
  );
}
