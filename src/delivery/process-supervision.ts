import { spawnSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { DeliveryError } from './contract.js';

export interface StageProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly group: number;
  readonly state: string;
}

export function stageProcesses(group: string): readonly StageProcess[] {
  if (!/^[1-9][0-9]*$/u.test(group)) {
    throw new DeliveryError('stage-process-group-invalid', true);
  }
  const result = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,pgid=,stat='], {
    encoding: 'utf8',
    timeout: 100,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new DeliveryError('stage-process-evidence-unavailable', true);
  }
  const members: StageProcess[] = [];
  for (const line of result.stdout.trim().split('\n')) {
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

export function assertNoStageOrphans(group: string, read = stageProcesses): void {
  const members = read(group);
  const identities = new Set(members.map((member) => member.pid));
  if (members.some((member) => member.pid !== Number(group) && !identities.has(member.parentPid))) {
    throw new DeliveryError('orphaned-provider-process', true);
  }
}

export async function assertStageProcessesStopped(
  group: string,
  read = stageProcesses,
): Promise<void> {
  const deadline = performance.now() + 250;
  do {
    if (read(group).length === 0) {
      return;
    }
    await sleep(10);
  } while (performance.now() < deadline);
  throw new DeliveryError('stage-process-cleanup-unconfirmed', true);
}
