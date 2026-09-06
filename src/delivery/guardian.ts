import { randomBytes, randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { spawnOwned, terminateOwned, waitForExit } from '../runtime/exec.js';
import { isAlive, pgidOf, procStartToken } from '../runtime/proc.js';
import { DELIVERY_REPOSITORY, DeliveryError, digest, type Mandate } from './contract.js';
import { restoreSharedMainHealth, sharedMainRecoveryIssue } from './main-recovery.js';
import {
  assertNoStageOrphans,
  assertStageProcessesStopped,
  StageProcessEvidenceError,
  type StageProcessReader,
} from './process-supervision.js';
import { DeliveryLedger, nextDeliveryDay, type ActivePermit, type ProcessOwner } from './ledger.js';

export const IDLE_WAIT_MS = 300_000;
export const CI_WAIT_MS = 60_000;

export function deliveryStateDirectory(): string {
  return path.join(os.homedir(), '.agent-quorum', 'delivery', 'eventbalancer-agent-quorum');
}

export function currentProcessOwner(): ProcessOwner {
  const startToken = procStartToken(process.pid);
  const pgid = pgidOf(process.pid);
  if (startToken === undefined || pgid === undefined) {
    throw new DeliveryError('process-identity-unavailable', true);
  }
  return { id: randomUUID(), pid: process.pid, pgid, startToken };
}

export function processOwnerIsLive(owner: ProcessOwner): boolean {
  if (!isAlive(owner.pid)) {
    return false;
  }
  const start = procStartToken(owner.pid);
  const group = pgidOf(owner.pid);
  if (start === undefined || group === undefined) {
    throw new DeliveryError('process-identity-unknown', true);
  }
  if (start !== owner.startToken || group !== owner.pgid) {
    throw new DeliveryError('process-ownership-identity-changed', true);
  }
  return true;
}

export function terminateRecordedOwner(owner: ProcessOwner): boolean {
  if (!processOwnerIsLive(owner)) {
    return false;
  }
  if (owner.pid === process.pid || owner.pgid === pgidOf(process.pid)) {
    throw new DeliveryError('refusing-to-terminate-guardian', true);
  }
  process.kill(-Number(owner.pgid), 'SIGKILL');
  return true;
}

export function acquireRepositoryOwner(
  owner: ProcessOwner,
  directory = path.join(os.homedir(), '.agent-quorum', 'delivery', 'owners'),
  isLive: (owner: ProcessOwner) => boolean = processOwnerIsLive,
): () => void {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const lock = path.join(directory, `${digest(DELIVERY_REPOSITORY)}.owner`);
  const recovery = `${lock}.recovery`;
  const write = () => {
    const descriptor = openSync(lock, 'wx', 0o600);
    try {
      writeFileSync(descriptor, JSON.stringify(owner));
    } finally {
      closeSync(descriptor);
    }
  };
  try {
    write();
  } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') {
      throw error;
    }
    let descriptor: number;
    try {
      descriptor = openSync(recovery, 'wx', 0o600);
    } catch {
      throw new DeliveryError('repository-ownership-recovery-in-progress', true);
    }
    try {
      const previous: unknown = JSON.parse(readFileSync(lock, 'utf8'));
      if (!isProcessOwner(previous)) {
        throw new DeliveryError('repository-ownership-unknown', true);
      }
      if (isLive(previous)) {
        throw new DeliveryError('live-repository-delivery-owner', true);
      }
      unlinkSync(lock);
      write();
    } finally {
      closeSync(descriptor);
      unlinkSync(recovery);
    }
  }
  return () => {
    if (existsSync(lock)) {
      const previous: unknown = JSON.parse(readFileSync(lock, 'utf8'));
      if (isProcessOwner(previous) && previous.id === owner.id) {
        unlinkSync(lock);
      }
    }
  };
}

function isProcessOwner(value: unknown): value is ProcessOwner {
  return (
    typeof value === 'object' &&
    value !== null &&
    'id' in value &&
    typeof value.id === 'string' &&
    'pid' in value &&
    typeof value.pid === 'number' &&
    Number.isSafeInteger(value.pid) &&
    value.pid > 0 &&
    'pgid' in value &&
    typeof value.pgid === 'string' &&
    /^\d+$/u.test(value.pgid) &&
    'startToken' in value &&
    typeof value.startToken === 'string' &&
    value.startToken !== ''
  );
}

interface AdmissionMessage {
  readonly version: 1;
  readonly requestId: string;
  readonly nonce: string;
  readonly type: 'watch' | 'before-spawn' | 'spawned';
  readonly attempt: { readonly command: string; readonly cwd: string };
  readonly process?: {
    readonly pid: number;
    readonly pgid: string;
    readonly procStartToken: string;
  };
}

function admissionMessage(value: unknown): AdmissionMessage {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('requestId' in value) ||
    typeof value.requestId !== 'string' ||
    value.requestId.length < 16 ||
    !('nonce' in value) ||
    typeof value.nonce !== 'string' ||
    !('type' in value) ||
    !['watch', 'before-spawn', 'spawned'].includes(String(value.type)) ||
    !('attempt' in value) ||
    typeof value.attempt !== 'object' ||
    value.attempt === null ||
    !('command' in value.attempt) ||
    typeof value.attempt.command !== 'string' ||
    !('cwd' in value.attempt) ||
    typeof value.attempt.cwd !== 'string'
  ) {
    throw new DeliveryError('invalid-execution-admission', true);
  }
  return value as AdmissionMessage;
}

export interface GuardianAdmission {
  readonly ledger: DeliveryLedger;
  readonly issue: number;
  readonly nonce: string;
  readonly deadlineEpochMs: number;
  readonly preflightDigest?: string;
  readonly blockedRecoveryDigest?: string;
  readonly processGroup: () => string | undefined;
  readonly verifyProviderPolicy?: (signal: AbortSignal) => Promise<void>;
  readonly verifyProcessTree?: (signal: AbortSignal) => Promise<void>;
}

function assertGuardianAuthority(options: GuardianAdmission, message: AdmissionMessage): void {
  if (message.nonce !== options.nonce || Date.now() >= options.deadlineEpochMs) {
    throw new DeliveryError('execution-admission-expired', true);
  }
  if (options.blockedRecoveryDigest !== undefined) {
    if (sharedMainRecoveryIssue(options.ledger, options.blockedRecoveryDigest) !== options.issue) {
      throw new DeliveryError('shared-main-recovery-issue-mismatch', true);
    }
  } else if (options.preflightDigest === undefined) {
    options.ledger.assertAuthorized('verify', options.issue);
  } else if (
    digest(options.ledger.mandate()) !== options.preflightDigest ||
    !['prepared', 'blocked'].includes(options.ledger.mode())
  ) {
    throw new DeliveryError('preflight-authorization-changed', true);
  }
}

export function admitGuardianRequest(options: GuardianAdmission, value: unknown): boolean {
  const message = admissionMessage(value);
  assertGuardianAuthority(options, message);
  if (
    message.type === 'before-spawn' &&
    ['codex', 'claude', 'cursor-agent'].includes(path.basename(message.attempt.command))
  ) {
    if (options.blockedRecoveryDigest !== undefined) {
      throw new DeliveryError('model-provider-forbidden-during-main-recovery', true);
    }
    try {
      options.ledger.reserveProvider(
        options.issue,
        Date.now(),
        message.requestId,
        options.preflightDigest,
      );
    } catch (error) {
      if (error instanceof DeliveryError) {
        options.ledger.set('execution-admission-blocker', {
          issue: options.issue,
          code: error.code,
        });
        if (
          error.code === 'provider-daily-attempt-limit' &&
          options.preflightDigest === undefined
        ) {
          options.ledger.set('daily-resume-after', nextDeliveryDay(Date.now()));
          options.ledger.changeMode('daily-limit', error.code);
        }
      }
      throw error;
    }
  }
  if (message.type === 'spawned') {
    const child = message.process;
    if (
      child === undefined ||
      !Number.isSafeInteger(child.pid) ||
      child.pid < 1 ||
      child.pgid !== options.processGroup() ||
      procStartToken(child.pid) !== child.procStartToken ||
      pgidOf(child.pid) !== child.pgid
    ) {
      throw new DeliveryError('spawned-process-ownership-mismatch', true);
    }
    const owner: ProcessOwner = {
      id: message.requestId,
      pid: child.pid,
      pgid: child.pgid,
      startToken: child.procStartToken,
    };
    const owned = options.ledger.get<ProcessOwner[]>('owned-processes') ?? [];
    options.ledger.set('owned-processes', [...owned.filter(processOwnerIsLive), owner]);
  }
  return message.type === 'watch';
}

export async function openGuardianAdmission(
  options: GuardianAdmission,
  socketPath: string,
): Promise<{
  readonly close: () => Promise<void>;
}> {
  const connections = new Set<Socket>();
  const pending = new Set<Promise<void>>();
  const cancellation = new AbortController();
  const server: Server = createServer((connection) => {
    connections.add(connection);
    connection.on('error', () => undefined);
    connection.on('close', () => connections.delete(connection));
    let input = '';
    let processed = false;
    connection.setTimeout(5000, () => connection.destroy());
    connection.on('data', (chunk: Buffer) => {
      if (processed) {
        connection.destroy();
        return;
      }
      input += chunk.toString();
      const newline = input.indexOf('\n');
      if (input.length > 8192) {
        connection.destroy();
        return;
      }
      if (newline < 0) {
        return;
      }
      processed = true;
      const answer = async () => {
        let authenticated = false;
        try {
          const message = admissionMessage(JSON.parse(input.slice(0, newline)) as unknown);
          assertGuardianAuthority(options, message);
          authenticated = true;
          await options.verifyProcessTree?.(cancellation.signal);
          cancellation.signal.throwIfAborted();
          const watch = admitGuardianRequest(options, message);
          if (
            message.type === 'before-spawn' &&
            path.basename(message.attempt.command) === 'codex'
          ) {
            await options.verifyProviderPolicy?.(cancellation.signal);
            await options.verifyProcessTree?.(cancellation.signal);
            cancellation.signal.throwIfAborted();
            admitGuardianRequest(options, message);
          }
          connection.write('{"ok":true}\n');
          if (watch) {
            connection.setTimeout(0);
          } else {
            connection.end();
          }
        } catch (error) {
          if (authenticated && !cancellation.signal.aborted && error instanceof DeliveryError) {
            options.ledger.set('execution-admission-blocker', {
              issue: options.issue,
              code: error.code,
            });
            if (
              error.isShared &&
              options.preflightDigest === undefined &&
              options.ledger.mode() === 'active'
            ) {
              options.ledger.changeMode('blocked', error.code);
            }
          }
          connection.end('{"ok":false}\n');
        }
      };
      const operation = answer();
      pending.add(operation);
      void operation.finally(() => pending.delete(operation));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  chmodSync(socketPath, 0o600);
  return {
    close: async () => {
      cancellation.abort();
      for (const connection of connections) {
        connection.destroy();
      }
      await Promise.allSettled(pending);
      return new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      });
    },
  };
}

function activeIssue(ledger: DeliveryLedger): number {
  const issues = ledger
    .issues()
    .filter((issue) => issue.stage !== 'done' && issue.stage !== 'deferred');
  const recorded = ledger.get<number>('current-issue') ?? 0;
  if (issues.length > 1 || recorded !== (issues[0]?.number ?? 0)) {
    throw new DeliveryError('active-issue-accounting-identity-mismatch', true);
  }
  return recorded;
}

function guardianBoot(): string {
  return `${process.platform}:${Math.round((Date.now() / 1000 - os.uptime()) / 60)}`;
}

function assertConfirmedCleanup(error: unknown): void {
  if (error !== undefined) {
    throw error instanceof Error
      ? error
      : new DeliveryError('stage-process-cleanup-unconfirmed', true);
  }
}

function recordStageProcessFailure(ledger: DeliveryLedger, issue: number, error: unknown): void {
  if (error instanceof StageProcessEvidenceError) {
    ledger.event('stage-process-evidence-failed', { issue, ...error.evidence });
  }
}

function deferExhaustedIssue(ledger: DeliveryLedger, issue: number): void {
  const current = ledger.issue(issue);
  if (current !== undefined) {
    ledger.set(`pending-status:${issue}`, {
      blocker: 'issue-active-limit',
      reconsiderWhen: 'explicit-authorized-allowance',
    });
    ledger.set(`resume-stage:${issue}`, current.stage);
    ledger.saveIssue({
      ...current,
      stage: 'deferred',
      blocker: 'issue-active-limit',
      reconsiderWhen: 'explicit-authorized-allowance',
    });
    ledger.set('current-issue', 0);
  }
}

export interface GuardianStepOptions {
  readonly preflightDigest?: string;
  readonly blockedRecoveryDigest?: string;
  readonly command?: { readonly bin: string; readonly args: readonly string[] };
  readonly signal?: AbortSignal;
  readonly readStageProcesses?: StageProcessReader;
}

export async function runGuardianStep(
  ledger: DeliveryLedger,
  options: GuardianStepOptions = {},
): Promise<number> {
  const mandate = ledger.mandate();
  const githubBackoffMs = (ledger.get<number>('github-backoff-until') ?? 0) - Date.now();
  if (githubBackoffMs > 0 && options.preflightDigest === undefined) {
    ledger.set('next-wait-ms', githubBackoffMs);
    return 0;
  }
  ledger.unset('execution-admission-blocker');
  const issue =
    options.blockedRecoveryDigest !== undefined
      ? sharedMainRecoveryIssue(ledger, options.blockedRecoveryDigest)
      : options.preflightDigest === undefined
        ? activeIssue(ledger)
        : 0;
  const wallAnchor = Date.now();
  const monotonicAnchor = performance.now();
  const budget = ledger.budget(issue, wallAnchor);
  const allowanceDeadline = Math.min(
    wallAnchor + Math.floor(budget.availableMs),
    nextDeliveryDay(wallAnchor),
  );
  const deadlineEpochMs =
    options.blockedRecoveryDigest === undefined
      ? allowanceDeadline
      : Math.min(
          allowanceDeadline,
          wallAnchor + Math.min(30_000, mandate.profile.bounds.commandTimeoutMs),
        );
  const deadlineMonotonicMs = monotonicAnchor + deadlineEpochMs - wallAnchor;
  const shutdownMarginMs = Math.min(500, budget.availableMs / 2);
  const identity = randomUUID();
  const nonce = randomBytes(24).toString('hex');
  const socketPath = path.join(
    os.tmpdir(),
    `aq-delivery-${process.pid}-${identity.slice(0, 8)}.sock`,
  );
  const handoffFile = path.join(ledger.directory, `execution-${identity}.json`);
  const boot = guardianBoot();
  let permit: ActivePermit | undefined;
  let stepGroup: string | undefined;
  const supervisionCancellation = new AbortController();
  let supervision: Promise<void> | undefined;
  let supervisionError: Error | undefined;
  const verifyProcessTree = async (signal: AbortSignal) => {
    if (stepGroup === undefined) {
      return;
    }
    try {
      const control = {
        signal,
        deadlineMonotonicMs: deadlineMonotonicMs - shutdownMarginMs,
      };
      await assertNoStageOrphans(stepGroup, control, options.readStageProcesses);
    } catch (error) {
      if (signal.aborted) {
        throw error;
      }
      if (performance.now() >= deadlineMonotonicMs - shutdownMarginMs) {
        throw new DOMException('Stage shutdown deadline reached', 'AbortError');
      }
      const code =
        error instanceof DeliveryError ? error.code : 'stage-process-evidence-unavailable';
      ledger.set('execution-admission-blocker', { issue, code });
      recordStageProcessFailure(ledger, issue, error);
      if (['active', 'prepared', 'blocked'].includes(ledger.mode())) {
        ledger.changeMode('blocked', code);
      }
      throw error;
    }
  };
  const startSupervision = () => {
    if (supervision !== undefined) {
      return;
    }
    supervision = verifyProcessTree(supervisionCancellation.signal)
      .catch((error: unknown) => {
        if (
          !supervisionCancellation.signal.aborted &&
          performance.now() < deadlineMonotonicMs - shutdownMarginMs
        ) {
          supervisionError =
            error instanceof Error
              ? error
              : new DeliveryError('stage-process-evidence-unavailable', true);
        }
      })
      .finally(() => {
        supervision = undefined;
      });
  };
  const admission = await openGuardianAdmission(
    {
      ledger,
      issue,
      nonce,
      deadlineEpochMs,
      ...(options.preflightDigest === undefined
        ? {}
        : { preflightDigest: options.preflightDigest }),
      ...(options.blockedRecoveryDigest === undefined
        ? {}
        : { blockedRecoveryDigest: options.blockedRecoveryDigest }),
      processGroup: () => stepGroup,
      verifyProcessTree,
      verifyProviderPolicy: async (signal) => {
        const { verifyMcpConfiguration } = await import('./activation.js');
        await verifyMcpConfiguration(mandate, {
          signal,
          deadlineEpochMs: Math.min(deadlineEpochMs, Date.now() + 4000),
          terminateGraceMs: 0,
        });
      },
    },
    socketPath,
  );
  writeFileSync(
    handoffFile,
    JSON.stringify({
      version: 1,
      deadlineEpochMs,
      processGroup: 'shared',
      socketPath,
      nonce,
      attemptTimeoutMs: mandate.profile.bounds.providerTimeoutMs,
      codexDeniedMcpServers: mandate.mcpServerNames,
    }),
    { mode: 0o600, flag: 'wx' },
  );
  const command = options.command ?? {
    bin: process.execPath,
    args: [
      path.join(mandate.runtimeRoot, 'dist/delivery/main.js'),
      options.blockedRecoveryDigest !== undefined
        ? 'internal-recovery'
        : options.preflightDigest === undefined
          ? 'internal-step'
          : 'internal-probe',
      '--state-dir',
      ledger.directory,
      ...(options.blockedRecoveryDigest !== undefined
        ? ['--digest', options.blockedRecoveryDigest]
        : options.preflightDigest === undefined
          ? []
          : ['--digest', options.preflightDigest]),
    ],
  };
  const logFile = openSync(path.join(ledger.directory, 'worker.log'), 'a', 0o600);
  let child: ReturnType<typeof spawnOwned> | undefined;
  let interrupted = false;
  try {
    permit = ledger.reserveActive(
      issue,
      performance.now(),
      Date.now(),
      boot,
      options.preflightDigest,
      options.blockedRecoveryDigest,
    );
    child = spawnOwned(command.bin, command.args, {
      cwd: mandate.runtimeRoot,
      stdio: ['ignore', logFile, logFile],
      env: { ...process.env, AGENT_QUORUM_EXECUTION_CONTROL_FILE: handoffFile },
    });
    if (child.pid === undefined) {
      throw new DeliveryError('step-process-unavailable', true);
    }
    stepGroup = String(child.pid);
    const startToken = procStartToken(child.pid);
    if (startToken === undefined || pgidOf(child.pid) !== stepGroup) {
      throw new DeliveryError('step-process-identity-unavailable', true);
    }
    const owner: ProcessOwner = { id: identity, pid: child.pid, pgid: stepGroup, startToken };
    ledger.claim('step', owner, processOwnerIsLive);
    ledger.set('owned-processes', [owner]);
    const state = { finished: false };
    const finished = () => state.finished;
    const completion = waitForExit(child).then((code) => {
      state.finished = true;
      return code;
    });
    startSupervision();
    while (!finished()) {
      if (permit === undefined) {
        await completion;
        break;
      }
      const untilPermit = Math.max(
        1,
        permit.monotonicStartMs + permit.reservedMs - performance.now(),
      );
      const untilShutdown = Math.max(1, deadlineMonotonicMs - shutdownMarginMs - performance.now());
      await Promise.race([completion, sleep(Math.min(250, untilPermit, untilShutdown))]);
      if (supervisionError !== undefined) {
        throw supervisionError;
      }
      const modeAllowed =
        options.blockedRecoveryDigest !== undefined
          ? ledger.mode() === 'blocked' &&
            digest(ledger.mandate()) === options.blockedRecoveryDigest
          : options.preflightDigest === undefined
            ? ledger.mode() === 'active'
            : ['prepared', 'blocked'].includes(ledger.mode()) &&
              digest(ledger.mandate()) === options.preflightDigest;
      const clockChanged =
        Math.abs(Date.now() - wallAnchor - (performance.now() - monotonicAnchor)) > 1000;
      const deadlineReached = performance.now() >= deadlineMonotonicMs - shutdownMarginMs;
      if (!modeAllowed || options.signal?.aborted === true || deadlineReached || clockChanged) {
        interrupted = true;
        await terminateOwned(child, 0);
        if (clockChanged) {
          ledger.set('clock-blocker', 'wall-clock-discontinuity');
          if (!['revoked', 'stopped'].includes(ledger.mode())) {
            ledger.changeMode('blocked', 'wall-clock-discontinuity');
          }
        }
        if (
          deadlineReached &&
          modeAllowed &&
          !clockChanged &&
          deadlineEpochMs === allowanceDeadline &&
          options.blockedRecoveryDigest === undefined
        ) {
          if (
            deadlineEpochMs >= nextDeliveryDay(permit.wallStartMs) ||
            issue === 0 ||
            budget.dailyMeasuredMs + budget.dailyReservedMs + budget.availableMs >= 360 * 60_000
          ) {
            ledger.set('daily-resume-after', nextDeliveryDay(wallAnchor));
            ledger.changeMode('daily-limit', 'daily-active-limit');
          } else {
            deferExhaustedIssue(ledger, issue);
          }
        }
      }
      if (finished() || interrupted) {
        break;
      }
      if (performance.now() >= permit.monotonicStartMs + permit.reservedMs) {
        const checkpoint = performance.now();
        ledger.settleActive(permit.id, checkpoint, boot);
        permit = undefined;
        if (ledger.get<string>('clock-blocker') !== undefined) {
          ledger.changeMode('blocked', 'active-clock-discontinuity');
          interrupted = true;
          await terminateOwned(child, 0);
        }
        if (!finished() && !interrupted) {
          try {
            permit = ledger.reserveActive(
              issue,
              checkpoint,
              wallAnchor + checkpoint - monotonicAnchor,
              boot,
              options.preflightDigest,
              options.blockedRecoveryDigest,
            );
          } catch (error) {
            interrupted = true;
            await terminateOwned(child, 0);
            if (options.blockedRecoveryDigest !== undefined) {
              ledger.event('shared-main-recovery-budget-blocked', { issue });
            } else if (error instanceof DeliveryError && error.code === 'daily-active-limit') {
              ledger.set('daily-resume-after', nextDeliveryDay(wallAnchor));
              ledger.changeMode('daily-limit', error.code);
            } else {
              ledger.event('issue-limit', { issue }, true);
              deferExhaustedIssue(ledger, issue);
            }
          }
        }
      }
      if (permit === undefined && !finished()) {
        await completion;
      }
      if (!finished() && !interrupted) {
        startSupervision();
      }
    }
    const code = await completion;
    return interrupted && code === 0 ? 1 : code;
  } finally {
    let cleanupError: unknown;
    try {
      supervisionCancellation.abort();
      const cleanup = await Promise.allSettled([
        admission.close(),
        supervision,
        child === undefined ? undefined : terminateOwned(child, 0),
      ]);
      for (const outcome of cleanup) {
        if (outcome.status === 'rejected') {
          assertConfirmedCleanup(
            outcome.reason ?? new DeliveryError('stage-process-cleanup-unconfirmed', true),
          );
        }
      }
      if (stepGroup !== undefined) {
        await assertStageProcessesStopped(stepGroup, options.readStageProcesses);
      }
    } catch (error) {
      cleanupError = error;
      recordStageProcessFailure(ledger, issue, error);
      ledger.set('cleanup-blocker', 'stage-process-cleanup-unconfirmed');
      if (!['revoked', 'stopped'].includes(ledger.mode())) {
        ledger.changeMode('blocked', 'stage-process-cleanup-unconfirmed');
      }
    } finally {
      if (cleanupError === undefined) {
        if (permit !== undefined) {
          ledger.settleActive(permit.id, performance.now(), boot);
        }
        if (ledger.owner('step')?.id === identity) {
          ledger.release('step', identity);
        }
        ledger.set('owned-processes', []);
        if (ledger.mode() === 'pausing') {
          ledger.changeMode('paused', 'pause-acknowledged');
        }
      }
      closeSync(logFile);
      if (existsSync(handoffFile)) {
        unlinkSync(handoffFile);
      }
    }
    assertConfirmedCleanup(cleanupError);
  }
}

export function stopOwnedDeliveryWork(ledger: DeliveryLedger): void {
  const owners = ledger.get<ProcessOwner[]>('owned-processes') ?? [];
  const step = ledger.owner('step');
  if (step !== undefined) {
    owners.unshift(step);
  }
  const killed = new Set<string>();
  for (const owner of owners) {
    if (!killed.has(owner.pgid) && terminateRecordedOwner(owner)) {
      killed.add(owner.pgid);
    }
  }
}

export async function awaitOwnedDeliveryStop(ledger: DeliveryLedger): Promise<void> {
  const step = ledger.owner('step');
  const owners = [
    ...(ledger.get<ProcessOwner[]>('owned-processes') ?? []),
    ...(step === undefined ? [] : [step]),
  ];
  stopOwnedDeliveryWork(ledger);
  const deadline = Date.now() + 5000;
  while (owners.some(processOwnerIsLive)) {
    if (Date.now() >= deadline) {
      throw new DeliveryError('process-cleanup-unconfirmed', true);
    }
    await sleep(25);
  }
  for (const group of new Set(owners.map((owner) => owner.pgid))) {
    await assertStageProcessesStopped(group);
  }
}

function aborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

export async function runDeliveryGuardian(
  ledger: DeliveryLedger,
  signal?: AbortSignal,
): Promise<void> {
  const owner = currentProcessOwner();
  const releaseRepository = acquireRepositoryOwner(owner);
  let claimed = false;
  try {
    ledger.claim('guardian', owner, processOwnerIsLive);
    claimed = true;
    ledger.retainInterruptedPermit();
    try {
      await awaitOwnedDeliveryStop(ledger);
    } catch (error) {
      ledger.set('cleanup-blocker', 'recovered-process-cleanup-unconfirmed');
      if (!['revoked', 'stopped'].includes(ledger.mode())) {
        ledger.changeMode('blocked', 'recovered-process-cleanup-unconfirmed');
      }
      throw error;
    }
    while (!aborted(signal)) {
      if (
        ledger.mode() === 'daily-limit' &&
        Date.now() >= (ledger.get<number>('daily-resume-after') ?? 0) &&
        ledger.budget(activeIssue(ledger), Date.now()).availableMs > 0
      ) {
        ledger.changeMode('active', 'next-daily-window');
      }
      if (['stopped', 'revoked'].includes(ledger.mode())) {
        return;
      }
      let waitMs = IDLE_WAIT_MS;
      const githubBackoffMs = (ledger.get<number>('github-backoff-until') ?? 0) - Date.now();
      if (githubBackoffMs > 0 && ['active', 'blocked'].includes(ledger.mode())) {
        waitMs = githubBackoffMs;
      } else if (ledger.mode() === 'active') {
        try {
          const status = await runGuardianStep(ledger, signal === undefined ? {} : { signal });
          waitMs = status === 0 ? (ledger.get<number>('next-wait-ms') ?? 0) : CI_WAIT_MS;
          if (status !== 0 && ledger.mode() === 'active') {
            ledger.changeMode('blocked', 'guardian-step-failed');
          }
        } catch (error) {
          const code = error instanceof DeliveryError ? error.code : 'guardian-step-failed';
          if (ledger.mode() === 'active') {
            ledger.changeMode(code === 'daily-active-limit' ? 'daily-limit' : 'blocked', code);
          }
        }
      } else if (ledger.mode() === 'blocked') {
        try {
          const authorization = digest(ledger.mandate());
          sharedMainRecoveryIssue(ledger, authorization);
          const code = await runGuardianStep(ledger, {
            blockedRecoveryDigest: authorization,
            ...(signal === undefined ? {} : { signal }),
          });
          waitMs = code === 0 && restoreSharedMainHealth(ledger, authorization) ? 0 : CI_WAIT_MS;
        } catch (error) {
          if (
            !(error instanceof DeliveryError) ||
            error.code !== 'shared-main-recovery-not-authorized'
          ) {
            ledger.event('shared-main-recovery-pending', {
              reason: error instanceof DeliveryError ? error.code : 'recovery-evidence-unavailable',
            });
            waitMs = CI_WAIT_MS;
          }
        }
      } else if (ledger.mode() === 'pausing') {
        ledger.changeMode('paused', 'pause-acknowledged');
      }
      const deadline = Date.now() + Math.min(IDLE_WAIT_MS, Math.max(0, waitMs));
      while (
        Date.now() < deadline &&
        !aborted(signal) &&
        !['stopped', 'revoked'].includes(ledger.mode())
      ) {
        await sleep(Math.min(1000, deadline - Date.now()));
      }
    }
  } finally {
    try {
      if (claimed) {
        await awaitOwnedDeliveryStop(ledger);
      }
    } finally {
      if (ledger.owner('guardian')?.id === owner.id) {
        ledger.release('guardian', owner.id);
      }
      releaseRepository();
    }
  }
}

function xml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

export function deliveryLaunchArguments(
  mandate: Mandate,
  stateDirectory: string,
  executable = process.execPath,
): string[] {
  return [
    executable,
    path.join(mandate.runtimeRoot, 'dist/delivery/main.js'),
    'daemon',
    '--state-dir',
    stateDirectory,
  ];
}

export function launchAgentDocument(
  mandate: Mandate,
  stateDirectory: string,
  executable = process.execPath,
): string {
  const args = deliveryLaunchArguments(mandate, stateDirectory, executable);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>Label</key><string>com.agent-quorum.delivery</string><key>ProgramArguments</key><array>${args.map((arg) => `<string>${xml(arg)}</string>`).join('')}</array><key>WorkingDirectory</key><string>${xml(mandate.runtimeRoot)}</string><key>RunAtLoad</key><true/><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict><key>ThrottleInterval</key><integer>60</integer><key>StandardOutPath</key><string>${xml(path.join(stateDirectory, 'guardian.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(stateDirectory, 'guardian.log'))}</string><key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(process.env.PATH ?? '/usr/bin:/bin')}</string><key>HOME</key><string>${xml(os.homedir())}</string></dict></dict></plist>\n`;
}
