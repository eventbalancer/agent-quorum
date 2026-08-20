import { existsSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createBlindBundle,
  DEFAULT_MANIFEST_FILE,
  runPlanningBenchmark,
  scorePlanningBenchmark,
} from './benchmark-planning/benchmark.js';

const USAGE = `usage:
  pnpm run benchmark:planning -- run --output <dir> [--manifest <file>]
  pnpm run benchmark:planning -- blind --results <file> --output <dir> --key <file> --seed <text> [--manifest <file>]
  pnpm run benchmark:planning -- score --results <file> --key <file> --review <file> --review <file> [--output <file>] [--manifest <file>]

Only the explicit run command invokes the source planning CLI and configured providers.
Blind and score are deterministic local artifact operations.
`;

interface ParsedOptions {
  readonly values: ReadonlyMap<string, string>;
  readonly reviews: readonly string[];
}

function parseOptions(args: readonly string[]): ParsedOptions {
  const values = new Map<string, string>();
  const reviews: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index] ?? '';
    if (!flag.startsWith('--')) {
      throw new Error(`unexpected argument: ${flag}`);
    }
    const value = args[index + 1] ?? '';
    if (value === '' || value.startsWith('--')) {
      throw new Error(`${flag} requires a value`);
    }
    if (flag === '--review') {
      reviews.push(value);
    } else {
      if (values.has(flag)) {
        throw new Error(`duplicate option: ${flag}`);
      }
      values.set(flag, value);
    }
    index += 1;
  }
  return { values, reviews };
}

function value(options: ParsedOptions, flag: string, required = true): string | undefined {
  const selected = options.values.get(flag);
  if (required && selected === undefined) {
    throw new Error(`${flag} is required`);
  }
  return selected;
}

function manifestFile(options: ParsedOptions): string {
  return value(options, '--manifest', false) ?? DEFAULT_MANIFEST_FILE;
}

function repositoryRoot(): string {
  return realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
}

function ensureAllowedOptions(options: ParsedOptions, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  for (const flag of options.values.keys()) {
    if (!allowedSet.has(flag)) {
      throw new Error(`unknown option: ${flag}`);
    }
  }
}

function runCommand(options: ParsedOptions): number {
  ensureAllowedOptions(options, ['--output', '--manifest']);
  if (options.reviews.length > 0) {
    throw new Error('--review is not valid for run');
  }
  const outputDir = value(options, '--output');
  if (outputDir === undefined) {
    throw new Error('--output is required');
  }
  const results = runPlanningBenchmark({
    outputDir,
    manifestFile: manifestFile(options),
    repositoryRoot: repositoryRoot(),
  });
  const failed = results.tasks.filter((task) => task.decision === 'run-failed');
  process.stdout.write(
    `planning benchmark completed: ${results.tasks.length - failed.length}/${results.tasks.length} runs produced terminal decisions\n`,
  );
  return failed.length === 0 ? 0 : 1;
}

function blindCommand(options: ParsedOptions): number {
  ensureAllowedOptions(options, ['--results', '--output', '--key', '--seed', '--manifest']);
  if (options.reviews.length > 0) {
    throw new Error('--review is not valid for blind');
  }
  const resultsFile = value(options, '--results');
  const outputDir = value(options, '--output');
  const keyFile = value(options, '--key');
  const seed = value(options, '--seed');
  if (
    resultsFile === undefined ||
    outputDir === undefined ||
    keyFile === undefined ||
    seed === undefined
  ) {
    throw new Error('blind requires results, output, key, and seed');
  }
  createBlindBundle({
    resultsFile,
    outputDir,
    keyFile,
    seed,
    manifestFile: manifestFile(options),
  });
  process.stdout.write(
    `blind bundle: ${path.resolve(outputDir)}\nanswer key: ${path.resolve(keyFile)}\n`,
  );
  return 0;
}

function scoreCommand(options: ParsedOptions): number {
  ensureAllowedOptions(options, ['--results', '--key', '--output', '--manifest']);
  const resultsFile = value(options, '--results');
  const keyFile = value(options, '--key');
  if (resultsFile === undefined || keyFile === undefined) {
    throw new Error('score requires results and key');
  }
  const report = scorePlanningBenchmark({
    resultsFile,
    keyFile,
    reviewFiles: options.reviews,
    manifestFile: manifestFile(options),
  });
  const outputFile = value(options, '--output', false);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (outputFile === undefined) {
    process.stdout.write(serialized);
  } else {
    const resolvedOutput = path.resolve(outputFile);
    if (existsSync(resolvedOutput)) {
      throw new Error(`score output already exists: ${resolvedOutput}`);
    }
    writeFileSync(resolvedOutput, serialized);
    process.stdout.write(`score report: ${resolvedOutput}\n`);
  }
  return report.accepted ? 0 : 1;
}

export function runPlanningBenchmarkCli(args: readonly string[]): number {
  const normalizedArgs = args[0] === '--' ? args.slice(1) : args;
  const command = normalizedArgs[0];
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(USAGE);
    return 0;
  }
  const options = parseOptions(normalizedArgs.slice(1));
  if (command === 'run') {
    return runCommand(options);
  }
  if (command === 'blind') {
    return blindCommand(options);
  }
  if (command === 'score') {
    return scoreCommand(options);
  }
  throw new Error(`unknown command: ${command}`);
}

function isDirectExecution(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(path.resolve(entry)).href;
}

if (isDirectExecution()) {
  try {
    process.exitCode = runPlanningBenchmarkCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`benchmark:planning: ${message}\n`);
    process.exitCode = 2;
  }
}
