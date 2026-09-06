import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeliveryError } from './contract.js';

const SNAPSHOT_TIMEOUT_MS = 1000;
const SNAPSHOT_OUTPUT_BYTES = 8 * 1024 * 1024;
const CLEANUP_TIMEOUT_MS = 250;

export interface StageProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly group: number;
  readonly state: string;
}

export interface StageProcessControl {
  readonly deadlineMonotonicMs?: number;
  readonly signal?: AbortSignal;
}

export type StageProcessReader = (
  group: string,
  control: StageProcessControl,
) => Promise<readonly StageProcess[]>;

type SnapshotFailure = 'timeout' | 'cancelled' | 'spawn' | 'read' | 'exit' | 'output-limit';

export interface StageProcessFailure {
  readonly reason: SnapshotFailure;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly errorCode?: string;
}

export class StageProcessEvidenceError extends DeliveryError {
  constructor(readonly evidence: StageProcessFailure) {
    super('stage-process-evidence-unavailable', true);
  }
}

function processMembers(group: string, output: string): readonly StageProcess[] {
  const members: StageProcess[] = [];
  for (const line of output.trim().split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*$/u.exec(line);
    if (match === null) {
      throw new DeliveryError('stage-process-evidence-invalid', true);
    }
    const [pid, parentPid, processGroup] = match.slice(1, 4).map(Number);
    const state = match[4];
    if (
      pid === undefined ||
      parentPid === undefined ||
      processGroup === undefined ||
      state === undefined ||
      ![pid, parentPid, processGroup].every(Number.isSafeInteger)
    ) {
      throw new DeliveryError('stage-process-evidence-invalid', true);
    }
    if (processGroup === Number(group) && !state.startsWith('Z')) {
      members.push({ pid, parentPid, group: processGroup, state });
    }
  }
  return members;
}

export async function stageProcesses(
  group: string,
  control: StageProcessControl = {},
): Promise<readonly StageProcess[]> {
  if (!/^[1-9][0-9]*$/u.test(group)) {
    throw new DeliveryError('stage-process-group-invalid', true);
  }
  if (control.deadlineMonotonicMs !== undefined && !Number.isFinite(control.deadlineMonotonicMs)) {
    throw new DeliveryError('stage-process-deadline-invalid', true);
  }
  const deadline = Math.min(
    performance.now() + SNAPSHOT_TIMEOUT_MS,
    control.deadlineMonotonicMs ?? Infinity,
  );
  if (control.signal?.aborted === true || performance.now() >= deadline) {
    throw new StageProcessEvidenceError({
      reason: control.signal?.aborted === true ? 'cancelled' : 'timeout',
      exitCode: null,
      signal: null,
    });
  }
  const output = await readProcessSnapshot(deadline, control.signal);
  return processMembers(group, output);
}

function readProcessSnapshot(deadline: number, signal?: AbortSignal): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat='], {
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: SnapshotFailure | undefined;
    let errorCode: string | undefined;
    const stop = (reason: SnapshotFailure) => {
      failure ??= reason;
      child.kill('SIGKILL');
    };
    const timer = setTimeout(
      () => {
        stop('timeout');
      },
      Math.max(1, deadline - performance.now()),
    );
    const cancel = () => {
      stop('cancelled');
    };
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > SNAPSHOT_OUTPUT_BYTES) {
        stop('output-limit');
      } else {
        chunks.push(chunk);
      }
    });
    child.once('error', (error: NodeJS.ErrnoException) => {
      failure ??= 'spawn';
      if (error.code !== undefined && /^[A-Z][A-Z0-9_]+$/u.test(error.code)) {
        errorCode = error.code;
      }
    });
    child.stdout.once('error', () => {
      stop('read');
    });
    child.once('close', (exitCode, exitSignal) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      if (failure === undefined && performance.now() >= deadline) {
        failure = 'timeout';
      }
      if (failure !== undefined || exitCode !== 0) {
        const evidence: StageProcessFailure = {
          reason: failure ?? 'exit',
          exitCode,
          signal: exitSignal,
          ...(errorCode === undefined ? {} : { errorCode }),
        };
        reject(new StageProcessEvidenceError(evidence));
      } else {
        resolve(Buffer.concat(chunks).toString('utf8'));
      }
    });
  });
}

export async function assertNoStageOrphans(
  group: string,
  control: StageProcessControl = {},
  read: StageProcessReader = stageProcesses,
): Promise<void> {
  const members = await read(group, control);
  const identities = new Set(members.map((member) => member.pid));
  if (members.some((member) => member.pid !== Number(group) && !identities.has(member.parentPid))) {
    throw new DeliveryError('orphaned-provider-process', true);
  }
}

export async function assertStageProcessesStopped(
  group: string,
  read: StageProcessReader = stageProcesses,
): Promise<void> {
  const deadlineMonotonicMs = performance.now() + CLEANUP_TIMEOUT_MS;
  do {
    const members = await read(group, { deadlineMonotonicMs });
    if (performance.now() >= deadlineMonotonicMs) {
      break;
    }
    if (members.length === 0) {
      return;
    }
    await sleep(Math.min(10, Math.max(1, deadlineMonotonicMs - performance.now())));
  } while (performance.now() < deadlineMonotonicMs);
  throw new DeliveryError('stage-process-cleanup-unconfirmed', true);
}
