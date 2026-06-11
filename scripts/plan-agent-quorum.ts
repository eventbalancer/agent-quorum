#!/usr/bin/env tsx
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import type { Effort, RunPlanLoopOptions, RunResult } from 'agent-quorum';

type AgentQuorumApi = typeof import('agent-quorum');

interface ParsedArgs {
  help: boolean;
  input?: string;
  prompt: boolean;
  fix: boolean;
  dryRun: boolean;
  locale: string;
  iters?: number;
  effort?: Effort;
  translate?: boolean;
  workDir?: string;
  configFile?: string;
}

type RunnableArgs = ParsedArgs & { readonly input: string };

interface ResultLine {
  readonly label: string;
  readonly value: string | number | undefined;
}

class UsageError extends Error {}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, '..');
const defaultConfigFile = path.join(repoRoot, 'plan-loop.json');
const defaultPlansDir = path.join(repoRoot, '.agents', 'plans');
const DEFAULT_EFFORT: Effort = 'high';
const DEFAULT_ITERS = 3;
const DEFAULT_LOCALE = 'en';
const MAX_WORKDIR_SLUG_LENGTH = 48;
const PACKAGE_NAME = 'agent-quorum';
const SLUG_EDGE_DASHES_PATTERN = /^-+|-+$/g;
const SLUG_UNSAFE_CHARS_PATTERN = /[^a-z0-9]+/g;
const TIMESTAMP_UNSAFE_CHARS_PATTERN = /[:.]/g;

function usage(): string {
  return [
    'Usage:',
    '  pnpm exec tsx scripts/plan-agent-quorum.ts --prompt <task.md> [options]',
    '  pnpm exec tsx scripts/plan-agent-quorum.ts <plan.md> [options]',
    '',
    'Options:',
    '  --prompt <file>       Treat input as a task prompt instead of a plan',
    '  --work <dir>          Override the work directory',
    '  --config <file>       Override plan-loop.json',
    '  --iters <n>           Iteration cap, default: 3',
    '  --effort <level>      low | high | max, default: high',
    '  --locale <tag>        Locale for operator interaction, default: en',
    '  --translate           Enable companion translated final plan',
    '  --no-translate        Disable companion translated final plan',
    '  --fix                 Enable fix pass, default',
    '  --no-fix              Disable fix pass',
    '  --dry-run             Print computed RunPlanLoopOptions and exit',
    '  -h, --help            Show this help',
  ].join('\n');
}

function requireValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index + 1];
  if (value === undefined || value.startsWith('--')) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

function parseIters(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new UsageError('--iters must be a positive integer');
  }
  return parsed;
}

function parseEffort(value: string): Effort {
  if (value === 'low' || value === 'high' || value === 'max') {
    return value;
  }
  throw new UsageError('--effort must be one of: low, high, max');
}

function parseArgs(args: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    help: false,
    prompt: false,
    fix: true,
    dryRun: false,
    locale: DEFAULT_LOCALE,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }

    switch (arg) {
      case '-h':
      case '--help':
        parsed.help = true;
        break;
      case '--prompt':
        parsed.prompt = true;
        parsed.input = requireValue(args, index, arg);
        index += 1;
        break;
      case '--work':
        parsed.workDir = requireValue(args, index, arg);
        index += 1;
        break;
      case '--config':
        parsed.configFile = requireValue(args, index, arg);
        index += 1;
        break;
      case '--iters':
        parsed.iters = parseIters(requireValue(args, index, arg));
        index += 1;
        break;
      case '--effort':
        parsed.effort = parseEffort(requireValue(args, index, arg));
        index += 1;
        break;
      case '--locale':
        parsed.locale = requireValue(args, index, arg);
        index += 1;
        break;
      case '--translate':
        parsed.translate = true;
        break;
      case '--no-translate':
        parsed.translate = false;
        break;
      case '--fix':
        parsed.fix = true;
        break;
      case '--no-fix':
        parsed.fix = false;
        break;
      case '--dry-run':
        parsed.dryRun = true;
        break;
      default:
        if (arg.startsWith('-')) {
          throw new UsageError(`unknown option: ${arg}`);
        }
        if (parsed.input !== undefined) {
          throw new UsageError(`unexpected extra input: ${arg}`);
        }
        parsed.input = arg;
    }
  }

  return parsed;
}

function requireRunnableArgs(parsed: ParsedArgs): RunnableArgs {
  if (parsed.input === undefined) {
    throw new UsageError('missing input file');
  }
  return { ...parsed, input: parsed.input };
}

function resolveFromRepo(value: string): string {
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(SLUG_UNSAFE_CHARS_PATTERN, '-')
    .replace(SLUG_EDGE_DASHES_PATTERN, '')
    .slice(0, MAX_WORKDIR_SLUG_LENGTH);
}

function defaultWorkDir(input: string): string {
  const parsed = path.parse(input);
  const base = slug(parsed.name) || 'task';
  const stamp = new Date().toISOString().replace(TIMESTAMP_UNSAFE_CHARS_PATTERN, '-');
  return path.join(defaultPlansDir, `${base}-${stamp}`);
}

export function buildSelfPlanningRunOptions(args: RunnableArgs): RunPlanLoopOptions {
  const input = resolveFromRepo(args.input);
  return {
    input,
    prompt: args.prompt,
    iters: args.iters ?? DEFAULT_ITERS,
    effort: args.effort ?? DEFAULT_EFFORT,
    fix: args.fix,
    translate: args.translate ?? false,
    locale: args.locale,
    workDir: args.workDir === undefined ? defaultWorkDir(input) : resolveFromRepo(args.workDir),
    configFile:
      args.configFile === undefined ? defaultConfigFile : resolveFromRepo(args.configFile),
  };
}

function ensureBuilt(): void {
  const distEntry = path.join(repoRoot, 'dist', 'index.js');
  if (!existsSync(distEntry)) {
    throw new UsageError('dist/index.js is missing; run `pnpm run build` before this harness');
  }
}

function printResult(result: RunResult): void {
  const lines: readonly ResultLine[] = [
    { label: 'exitCode', value: result.exitCode },
    { label: 'workDir', value: result.workDir },
    { label: 'finalPlanPath', value: result.finalPlanPath },
    { label: 'summaryPath', value: result.summaryPath },
    { label: 'iterations', value: result.iterations },
  ];
  for (const { label, value } of lines) {
    if (value !== undefined) {
      process.stdout.write(`${label}: ${value}\n`);
    }
  }
}

async function main(): Promise<number> {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }

    const options = buildSelfPlanningRunOptions(requireRunnableArgs(parsed));
    if (!existsSync(options.input)) {
      throw new UsageError(`input file does not exist: ${options.input}`);
    }

    process.stdout.write(`${JSON.stringify(options, null, 2)}\n`);
    if (parsed.dryRun) {
      return 0;
    }

    ensureBuilt();
    const { runPlanLoop } = (await import(PACKAGE_NAME)) as AgentQuorumApi;
    const result = await runPlanLoop(options);
    printResult(result);
    return result.exitCode;
  } catch (error: unknown) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${usage()}\n`);
      return 1;
    }
    throw error;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
