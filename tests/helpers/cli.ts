import { spawn, spawnSync, type SpawnSyncReturns } from 'node:child_process';
import path from 'node:path';
import { REPO_ROOT, stripAnsi } from './harness.js';

export const TSX_BIN = path.join(REPO_ROOT, 'node_modules', '.bin', 'tsx');
export const MAIN_TS = path.join(REPO_ROOT, 'src', 'cli', 'main.ts');

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type EnvOverrides = Readonly<Record<string, string | undefined>>;

function mergedEnv(env: EnvOverrides): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      Reflect.deleteProperty(merged, key);
    } else {
      merged[key] = value;
    }
  }
  return merged;
}

export function runCli(
  args: readonly string[],
  env: EnvOverrides = {},
  input?: string,
  cwd?: string,
): CliResult {
  const result: SpawnSyncReturns<string> = spawnSync(TSX_BIN, [MAIN_TS, ...args], {
    encoding: 'utf8',
    env: mergedEnv(env),
    ...(input === undefined ? {} : { input }),
    ...(cwd === undefined ? {} : { cwd }),
    timeout: 120_000,
  });
  return {
    status: result.status ?? -1,
    stdout: stripAnsi(result.stdout || ''),
    stderr: stripAnsi(result.stderr || ''),
  };
}

// Async variant for scenarios where the test process must keep serving (e.g.
// the Telegram stub) while the CLI runs.
export async function runCliAsync(
  args: readonly string[],
  env: EnvOverrides = {},
  cwd?: string,
): Promise<CliResult> {
  const child = spawn(TSX_BIN, [MAIN_TS, ...args], {
    env: mergedEnv(env),
    ...(cwd === undefined ? {} : { cwd }),
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const status = await new Promise<number>((resolve) => {
    child.once('exit', (code) => {
      resolve(code ?? -1);
    });
    child.once('error', () => {
      resolve(-1);
    });
  });
  return { status, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr) };
}
