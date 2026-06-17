import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { HaltError } from '../runtime/halt.js';
import { resolveArtifactRoots } from '../runtime/paths.js';
import { resolveConfigForHome } from '../core/config.js';
import { pruneRuns, resolveRunState, type RetentionPolicy } from '../core/run-store.js';
import { LOGS_USAGE, PRUNE_USAGE, SHOW_USAGE } from './help.js';
import { systemProbes } from './probes.js';
import {
  isRunRecord,
  parseSelector,
  resolveLogPath,
  resolveSelector,
  type ResolvedRun,
  type SelectorFlags,
} from './select.js';

const FOLLOW_POLL_MS = 200;

type Writer = (text: string) => void;
const stdout: Writer = (text) => {
  process.stdout.write(text);
};

interface ParsedRunsArgs {
  readonly token: string | undefined;
  readonly flags: SelectorFlags;
  readonly follow: boolean;
  readonly help: boolean;
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  throw new HaltError(message, code, true);
}

export interface ValueFlagMatch {
  readonly value: string | undefined;
  readonly lastIndex: number;
}

// Match `--name value` or `--name=value` at args[index]. `value` is the following
// arg (undefined for a trailing bare flag) or the inline tail after `=`;
// `lastIndex` is the final consumed index, so the caller advances its loop cursor
// to it. Returns undefined when the flag does not match.
export function matchValueFlag(
  args: readonly string[],
  index: number,
  name: string,
): ValueFlagMatch | undefined {
  const arg = args[index];
  if (arg === name) {
    return { value: args[index + 1], lastIndex: index + 1 };
  }
  const inline = `${name}=`;
  if (arg?.startsWith(inline) === true) {
    return { value: arg.slice(inline.length), lastIndex: index };
  }
  return undefined;
}

function parseRunsArgs(args: readonly string[]): ParsedRunsArgs {
  let token: string | undefined;
  let work: string | undefined;
  let last = false;
  let follow = false;
  let help = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    const workFlag = matchValueFlag(args, index, '--work');
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '-f' || arg === '--follow') {
      follow = true;
    } else if (arg === '--last') {
      last = true;
    } else if (workFlag !== undefined) {
      work = workFlag.value;
      index = workFlag.lastIndex;
    } else if (arg.startsWith('-')) {
      fail(`unknown flag: ${arg}`, 2);
    } else if (token === undefined) {
      token = arg;
    } else {
      fail(`unexpected argument: ${arg}`, 2);
    }
  }
  const flags: SelectorFlags = {
    ...(last ? { last: true } : {}),
    ...(work !== undefined ? { work } : {}),
  };
  return { token, flags, follow, help };
}

function resolveSelected(parsed: ParsedRunsArgs): ResolvedRun | undefined {
  const selector = parseSelector(parsed.token, parsed.flags);
  if (selector === undefined) {
    return undefined;
  }
  return resolveSelector(selector, { stateDir: resolveArtifactRoots().stateDir });
}

function presence(file: string): string {
  return existsSync(file) ? 'present' : 'missing';
}

export function runShowCli(args: readonly string[], out: Writer = stdout): number {
  const parsed = parseRunsArgs(args);
  if (parsed.help) {
    out(SHOW_USAGE);
    return 0;
  }
  const resolved = resolveSelected(parsed);
  if (resolved === undefined) {
    fail(`no run matches selector: ${parsed.token ?? '(none)'}`, 2);
  }
  const workDir = resolved.workDir;
  const planFile = path.join(workDir, 'plan.final.md');
  const summaryFile = path.join(workDir, 'summary.md');
  const logFile = resolveLogPath(resolved);
  const lines: string[] = [];
  if (isRunRecord(resolved)) {
    lines.push(
      `run ${resolved.runId} (${resolved.name}) — ${resolveRunState(resolved, systemProbes)}`,
    );
  }
  lines.push(`  workdir: ${workDir}`);
  lines.push(`  plan:    ${planFile} [${presence(planFile)}]`);
  lines.push(`  summary: ${summaryFile} [${presence(summaryFile)}]`);
  lines.push(`  log:     ${logFile} [${presence(logFile)}]`);
  out(`${lines.join('\n')}\n`);
  return 0;
}

function drainFrom(logFile: string, offset: number, out: Writer): number {
  const size = statSync(logFile).size;
  if (size <= offset) {
    return offset;
  }
  const fd = openSync(logFile, 'r');
  try {
    const buffer = Buffer.alloc(size - offset);
    readSync(fd, buffer, 0, buffer.length, offset);
    out(buffer.toString('utf8'));
  } finally {
    closeSync(fd);
  }
  return size;
}

// Tail-follow run.log in pure Node: drain appended bytes on each poll and stop
// once the run is no longer live. A resolved record without liveness (a bare
// --work target) drains once and returns rather than blocking.
async function followLog(logFile: string, resolved: ResolvedRun, out: Writer): Promise<void> {
  let offset = drainFrom(logFile, 0, out);
  for (;;) {
    const isLive = isRunRecord(resolved) && resolveRunState(resolved, systemProbes) === 'running';
    if (!isLive) {
      drainFrom(logFile, offset, out);
      return;
    }
    await sleep(FOLLOW_POLL_MS);
    offset = drainFrom(logFile, offset, out);
  }
}

export async function runLogsCli(args: readonly string[], out: Writer = stdout): Promise<number> {
  const parsed = parseRunsArgs(args);
  if (parsed.help) {
    out(LOGS_USAGE);
    return 0;
  }
  const resolved = resolveSelected(parsed);
  if (resolved === undefined) {
    fail(`no run matches selector: ${parsed.token ?? '(none)'}`, 2);
  }
  const logFile = resolveLogPath(resolved);
  if (!existsSync(logFile)) {
    out(`no run.log for this run; it streamed to its console. inspect ${resolved.workDir}\n`);
    return 0;
  }
  if (!parsed.follow) {
    out(readFileSync(logFile, 'utf8'));
    return 0;
  }
  await followLog(logFile, resolved, out);
  return 0;
}

function parseCount(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (value === undefined || !Number.isInteger(parsed) || parsed < 0) {
    fail(`${flag} requires a non-negative integer`, 2);
  }
  return parsed;
}

interface ParsedPrunePolicy {
  keepCount?: number;
  maxAgeDays?: number;
  dryRun: boolean;
}

interface ParsedPruneArgs {
  readonly policy: ParsedPrunePolicy;
  readonly help: boolean;
}

function parsePruneArgs(args: readonly string[]): ParsedPruneArgs {
  const policy: ParsedPrunePolicy = { dryRun: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) {
      continue;
    }
    const keepFlag = matchValueFlag(args, index, '--keep');
    const maxAgeFlag = matchValueFlag(args, index, '--max-age');
    if (arg === '-h' || arg === '--help') {
      return { policy, help: true };
    } else if (arg === '--dry-run') {
      policy.dryRun = true;
    } else if (keepFlag !== undefined) {
      policy.keepCount = parseCount(keepFlag.value, '--keep');
      index = keepFlag.lastIndex;
    } else if (maxAgeFlag !== undefined) {
      policy.maxAgeDays = parseCount(maxAgeFlag.value, '--max-age');
      index = maxAgeFlag.lastIndex;
    } else {
      fail(`unknown flag: ${arg}`, 2);
    }
  }
  return { policy, help: false };
}

export function runPruneCli(args: readonly string[], out: Writer = stdout): number {
  const { policy, help } = parsePruneArgs(args);
  if (help) {
    out(PRUNE_USAGE);
    return 0;
  }
  const retention: RetentionPolicy = {
    ...(policy.keepCount !== undefined ? { keepCount: policy.keepCount } : {}),
    ...(policy.maxAgeDays !== undefined ? { maxAgeDays: policy.maxAgeDays } : {}),
    dryRun: policy.dryRun,
  };
  const { home, stateDir } = resolveArtifactRoots();
  const defaults = resolveConfigForHome(home).retention;
  const result = pruneRuns(stateDir, retention, defaults);
  const verb = policy.dryRun ? 'would remove' : 'removed';
  out(`${verb} ${result.removed.length} run record(s); kept ${result.kept}\n`);
  return 0;
}
