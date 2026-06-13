import { accessSync, constants, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { log } from '../../runtime/log.js';
import type { Runner } from '../../types.js';

export function commandExists(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return true;
      }
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

const PROBE_TIMEOUT_MS = 3000;

interface RunnerProbe {
  binary: string;
  args: string[];
  remedy: string;
}

function probeTable(cursorBin: string): Record<Runner, RunnerProbe> {
  return {
    codex: { binary: 'codex', args: ['login', 'status'], remedy: 'codex login' },
    claude: { binary: 'claude', args: ['auth', 'status'], remedy: 'claude auth login' },
    cursor: { binary: cursorBin, args: ['status'], remedy: `${cursorBin} login` },
  };
}

export interface PreflightFailure {
  message: string;
}

// Auth-probe outcomes: exit 0 → authenticated; exit 1 → not authenticated
// (the only blocking outcome); anything else — missing subcommand, timeout,
// spawn failure — is "unknown": warn and continue, a probe must never
// false-block a run.
function probeAuth(runner: Runner, cursorBin: string): string | undefined {
  const probe = probeTable(cursorBin)[runner];
  let status: number | null;
  try {
    const result = spawnSync(probe.binary, probe.args, { timeout: PROBE_TIMEOUT_MS });
    status = result.error !== undefined ? null : result.status;
  } catch {
    status = null;
  }
  if (status === 0) {
    return undefined;
  }
  if (status === 1) {
    return `preflight: ${runner} is installed but not authenticated — run \`${probe.remedy}\``;
  }
  log(
    `preflight: could not verify ${runner} authentication (\`${probe.binary} ${probe.args.join(' ')}\` unavailable) — continuing`,
  );
  return undefined;
}

// Installation messages are byte-identical to the historic run.ts checks;
// auth probes run only for runners the effective config actually uses.
export function preflightRunners(
  required: readonly Runner[],
  cursorBin: string,
): PreflightFailure | undefined {
  for (const runner of required) {
    if (runner === 'codex' && !commandExists('codex')) {
      return { message: 'codex is required' };
    }
    if (runner === 'claude' && !commandExists('claude')) {
      return { message: 'claude is required' };
    }
    if (runner === 'cursor' && !commandExists(cursorBin)) {
      return { message: 'cursor-agent is required' };
    }
  }
  for (const runner of required) {
    const failure = probeAuth(runner, cursorBin);
    if (failure !== undefined) {
      return { message: failure };
    }
  }
  return undefined;
}
