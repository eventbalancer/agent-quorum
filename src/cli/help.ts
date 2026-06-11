import { readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../runtime/env.js';
import { configFilePath } from '../core/config.js';
import { isJsonObject, type JsonValue } from '../core/json.js';

// Single source of the usage strings for all four entry points — the bin is
// `plan-loop`; the reference *.sh names never appear in user-facing output.

export const RUN_USAGE =
  'usage: plan-loop [--iters N] [--effort {low,high,max}] [--no-fix] [--locale LOCALE] [--no-translate] <plan.md>\n' +
  '       plan-loop [--iters N] [--effort {low,high,max}] [--no-fix] [--locale LOCALE] [--no-translate] --prompt <prompt.md>\n';

export const LAUNCH_USAGE =
  'usage: plan-loop launch [--resume] [--iters N] [--effort {low,high,max}] [--prompt] [--no-fix] [--locale LOCALE] [--no-translate] <input.md>\n';

export const INTERVENE_USAGE =
  'usage: plan-loop intervene --work <workdir> [--target all|critic|creator|fixer|reviewer] <message...>\n' +
  '       plan-loop intervene --work <workdir> [--target all|critic|creator|fixer|reviewer] --stdin\n';

export const STATUS_USAGE =
  'plan-loop status — show progress of a plan-loop run.\n' +
  '\n' +
  'Usage:\n' +
  '  plan-loop status <PID>     — any PID in the run’s process tree (main or child)\n' +
  '  plan-loop status           — list all currently running plan-loop runs\n';

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

// Best-effort: read the effective config without validating it — an
// unreadable or shape-broken config must not break --help, so the defaults
// line is simply omitted.
function defaultsLine(): string {
  const file = configFilePath();
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  } catch {
    return '';
  }
  if (!isJsonObject(parsed) || !isJsonObject(parsed.settings)) {
    return '';
  }
  const settings = parsed.settings;
  const parts: string[] = [];
  for (const key of ['iters', 'effort', 'fix', 'locale', 'translate']) {
    const text = settingText(settings[key]);
    if (text !== undefined) {
      parts.push(`${key}=${text}`);
    }
  }
  if (parts.length === 0) {
    return '';
  }
  return `\ndefaults: ${parts.join(' ')} (from ${file})\n`;
}

export function globalHelp(): string {
  return (
    RUN_USAGE +
    '       plan-loop launch [--resume] [--iters N] [--effort {low,high,max}] [--prompt] [--no-fix] [--locale LOCALE] [--no-translate] <input.md>\n' +
    '       plan-loop status [PID]\n' +
    '       plan-loop intervene --work <workdir> [--target all|critic|creator|fixer|reviewer] <message...>\n' +
    '\n' +
    'subcommands:\n' +
    '  launch      detach a run into its own process group with run.log redirection\n' +
    '  status      show progress of running plan-loop runs\n' +
    '  intervene   append an operator intervention to a run’s ledger\n' +
    '\n' +
    'flags (core run):\n' +
    '  --iters N                     iteration cap\n' +
    '  --effort {low,high,max}       effort preset\n' +
    '  --fix / --no-fix              enable/disable the fix pass\n' +
    '  --locale LOCALE               localize human interaction and final companion plan\n' +
    '  --translate / --no-translate  compatibility toggle for the translate pass\n' +
    '  --prompt <prompt.md>          create plan.v0 from a prompt file first\n' +
    '  -h, --help                    print usage\n' +
    '\n' +
    'plan-loop --version (or -V, as the first argument) prints the package version.\n' +
    defaultsLine()
  );
}
