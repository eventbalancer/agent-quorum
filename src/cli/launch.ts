import { existsSync, mkdirSync, openSync, renameSync, statSync, closeSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawn } from 'node:child_process';
import { HaltError } from '../runtime/halt.js';
import { packageRoot, projectRoot } from '../runtime/env.js';
import { resolveResumeWorkdir } from '../core/resume.js';
import { LAUNCH_USAGE } from './help.js';
import type { RunOverrides } from '../types.js';

// The detached runner entry resolves from this module's own location (not
// process.argv) so the library API can launch too: dist runs node main.js,
// source runs main.ts through the local tsx.
interface RunnerCommand {
  command: string;
  baseArgs: string[];
}

function runnerCommand(): RunnerCommand {
  const here = fileURLToPath(import.meta.url);
  const dir = path.dirname(here);
  if (!here.endsWith('.ts')) {
    return { command: process.execPath, baseArgs: [path.join(dir, 'main.js')] };
  }
  if (process.execArgv.some((arg) => arg.includes('/tsx/'))) {
    return {
      command: process.execPath,
      baseArgs: [...process.execArgv, path.join(dir, 'main.ts')],
    };
  }
  const loader = pathToFileURL(
    path.join(packageRoot(), 'node_modules', 'tsx', 'dist', 'loader.mjs'),
  ).href;
  return {
    command: process.execPath,
    baseArgs: ['--import', loader, path.join(dir, 'main.ts')],
  };
}

function fail(message: string, code: number): never {
  process.stderr.write(`${message}\n`);
  throw new HaltError(message, code, true);
}

function rotationStamp(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

export interface LaunchOutcome {
  exitCode: number;
  workDir?: string;
  pid?: number;
  logPath?: string;
}

export async function runLaunchCli(
  args: readonly string[],
  out: (text: string) => void = (text) => process.stdout.write(text),
  overrides: RunOverrides = {},
): Promise<LaunchOutcome> {
  let resume = false;
  const passArgs: string[] = [];
  let input = '';
  let effortVal = '';

  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    switch (true) {
      case arg === '--resume':
        resume = true;
        i += 1;
        break;
      case arg === '--iters' || arg === '--max-iters': {
        const value = args[i + 1];
        if (value === undefined || value === '') {
          fail(`${arg} needs a value`, 2);
        }
        passArgs.push(arg, value);
        i += 2;
        break;
      }
      case arg === '--prompt': {
        const value = args[i + 1];
        if (value === undefined || value === '') {
          fail('--prompt needs a file', 2);
        }
        passArgs.push('--prompt', value);
        input = value;
        i += 2;
        break;
      }
      case arg === '--effort': {
        const value = args[i + 1];
        if (value === undefined || value === '') {
          fail('--effort needs a value', 2);
        }
        effortVal = value;
        passArgs.push('--effort', value);
        i += 2;
        break;
      }
      case arg.startsWith('--effort='):
        effortVal = arg.slice('--effort='.length);
        passArgs.push(arg);
        i += 1;
        break;
      case arg === '--locale': {
        const value = args[i + 1];
        if (value === undefined || value === '') {
          fail('--locale needs a value', 2);
        }
        passArgs.push('--locale', value);
        i += 2;
        break;
      }
      case arg.startsWith('--locale='):
        if (arg.slice('--locale='.length) === '') {
          fail('--locale needs a value', 2);
        }
        passArgs.push(arg);
        i += 1;
        break;
      case arg === '--fix' ||
        arg === '--no-fix' ||
        arg === '--translate' ||
        arg === '--no-translate':
        passArgs.push(arg);
        i += 1;
        break;
      case arg === '-h' || arg === '--help':
        out(LAUNCH_USAGE);
        return { exitCode: 0 };
      case arg === '--':
        i += 1;
        break;
      case arg.startsWith('-'):
        fail(`unknown flag: ${arg}`, 2);
        break;
      default:
        if (input !== '') {
          fail(`unexpected extra arg: ${arg}`, 2);
        }
        input = arg;
        passArgs.push(arg);
        i += 1;
        break;
    }
  }

  if (input === '') {
    process.stderr.write('missing input.md\n');
    process.stderr.write('see --help\n');
    throw new HaltError('missing input.md', 2, true);
  }
  if (!existsSync(input) || !statSync(input).isFile()) {
    fail(`input not found: ${input}`, 2);
  }

  const absInput = path.resolve(input);
  const base = path.basename(absInput, path.extname(absInput));
  const plansDir = process.env.PLAN_LOOP_PLANS_DIR ?? path.join(os.homedir(), '.claude', 'plans');

  let workOverride = overrides.workDir ?? process.env.PLAN_LOOP_WORK_DIR;
  if (resume && (workOverride === undefined || workOverride === '')) {
    const resolved = resolveResumeWorkdir(plansDir, base, effortVal);
    if (resolved.kind === 'none') {
      throw new HaltError('resume: no workdir', 3, true);
    }
    if (resolved.kind === 'ambiguous') {
      throw new HaltError('resume: ambiguous workdir', 4, true);
    }
    workOverride = resolved.dir;
    process.stderr.write(`resume: attaching to ${resolved.dir}\n`);
  }

  const work =
    workOverride !== undefined && workOverride !== ''
      ? workOverride
      : path.join(plansDir, `loop-${base}`);
  mkdirSync(work, { recursive: true });
  const logPath = path.join(work, 'run.log');

  if (existsSync(logPath) && statSync(logPath).size > 0) {
    renameSync(logPath, path.join(work, `run.${rotationStamp()}.log`));
  }

  const env: NodeJS.ProcessEnv = { ...process.env, CI: 'true' };
  if (resume) {
    env.PLAN_LOOP_RESUME = '1';
  }
  if (workOverride !== undefined && workOverride !== '') {
    env.PLAN_LOOP_WORK_DIR = workOverride;
  }
  if (overrides.configFile !== undefined) {
    env.PLAN_LOOP_CONFIG_FILE = overrides.configFile;
  }

  const runner = runnerCommand();
  const logFd = openSync(logPath, 'w');
  const child = spawn(runner.command, [...runner.baseArgs, ...passArgs], {
    cwd: projectRoot(),
    env,
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  closeSync(logFd);
  const pid = child.pid ?? 0;
  child.unref();

  const verifyDelay = Number(process.env.PLAN_LOOP_LAUNCH_VERIFY_DELAY ?? 1);
  await sleep(verifyDelay * 1000);
  let alive = true;
  try {
    process.kill(pid, 0);
  } catch {
    alive = false;
  }
  if (!alive) {
    fail(`launch failed: plan-loop exited immediately; inspect log: ${logPath}`, 1);
  }

  out(
    `started: ${base}\n` +
      `  pid:   ${pid}\n` +
      `  log:   ${logPath}\n` +
      `  work:  ${work}\n` +
      '\n' +
      `follow:  tail -F "${logPath}"\n` +
      `stop:    kill -TERM -${pid}\n`,
  );
  return { exitCode: 0, workDir: work, pid, logPath };
}
