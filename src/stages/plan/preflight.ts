import { spawnSync } from 'node:child_process';
import { log } from '../../runtime/log.js';
import { RUNNER_META } from '../../providers/registry.js';
import { commandExists } from '../../core/runner-detect.js';
import type { Runner } from '../../types.js';

const PROBE_TIMEOUT_MS = 3000;

interface RunnerProbe {
  binary: string;
  args: readonly string[];
  remedy: string;
}

function runnerProbe(runner: Runner, binary: string): RunnerProbe {
  return {
    binary,
    args: RUNNER_META[runner].auth.args,
    remedy: RUNNER_META[runner].auth.remedy(binary),
  };
}

export interface PreflightFailure {
  message: string;
}

// Auth-probe outcomes: exit 0 → authenticated; exit 1 → not authenticated
// (the only blocking outcome); anything else — missing subcommand, timeout,
// spawn failure — is "unknown": warn and continue, a probe must never
// false-block a run.
function probeAuth(runner: Runner, binaries: Record<Runner, string>): string | undefined {
  const probe = runnerProbe(runner, binaries[runner]);
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
  binaries: Record<Runner, string>,
): PreflightFailure | undefined {
  for (const runner of required) {
    if (!commandExists(binaries[runner])) {
      return { message: RUNNER_META[runner].install.message };
    }
  }
  for (const runner of required) {
    const failure = probeAuth(runner, binaries);
    if (failure !== undefined) {
      return { message: failure };
    }
  }
  return undefined;
}
