import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConnection } from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../../src/delivery/contract.js';
import {
  acquireRepositoryOwner,
  admitGuardianRequest,
  currentProcessOwner,
  launchAgentDocument,
  openGuardianAdmission,
  runGuardianStep,
} from '../../src/delivery/guardian.js';
import { deliveryFixture } from '../helpers/delivery.js';
import { nextDeliveryDay } from '../../src/delivery/ledger.js';
import {
  StageProcessEvidenceError,
  type StageProcessReader,
} from '../../src/delivery/process-supervision.js';

const cleanups: (() => void)[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => {
      cleanup();
    });
});
function fixture() {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  return result;
}

function message(type = 'before-spawn', nonce = 'n'.repeat(48), command = 'codex') {
  return {
    version: 1,
    requestId: 'request-1234567890',
    type,
    nonce,
    attempt: { command, cwd: '/fixture' },
  };
}

function sendAdmission(socketPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const connection = createConnection(socketPath);
    connection.once('error', reject);
    connection.once('connect', () => {
      connection.write(`${JSON.stringify(message('before-spawn', 'n'.repeat(48), 'git'))}\n`);
    });
    connection.once('data', (data: Buffer) => {
      connection.destroy();
      resolve(data.toString());
    });
  });
}

function delayedStageReader(delayMs: number): StageProcessReader {
  return async (group, control) => {
    if (control.signal === undefined) {
      return [];
    }
    await sleep(delayMs, undefined, { signal: control.signal });
    return [{ pid: Number(group), parentPid: process.pid, group: Number(group), state: 'S' }];
  };
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const deadlineStageReader: StageProcessReader = async (_group, control) => {
  if (control.signal === undefined) {
    return [];
  }
  const deadline = control.deadlineMonotonicMs ?? performance.now();
  await sleep(Math.max(1, deadline - performance.now()), undefined, { signal: control.signal });
  while (performance.now() < deadline) {
    await sleep(1, undefined, { signal: control.signal });
  }
  throw new StageProcessEvidenceError({ reason: 'timeout', exitCode: null, signal: 'SIGKILL' });
};

describe('delivery guardian admission', () => {
  it('requires live authority and nonce before consuming provider starts', () => {
    const { ledger } = fixture();
    const options = {
      ledger,
      issue: 0,
      nonce: 'n'.repeat(48),
      deadlineEpochMs: Date.now() + 60_000,
      processGroup: () => '1',
    };
    const reserve = vi.spyOn(ledger, 'reserveProvider');
    expect(() => admitGuardianRequest(options, message('before-spawn', 'wrong'))).toThrow(
      'execution-admission-expired',
    );
    expect(reserve).not.toHaveBeenCalled();
    expect(admitGuardianRequest(options, message())).toBe(false);
    expect(reserve).toHaveBeenCalledTimes(1);
    ledger.changeMode('paused', 'fixture');
    expect(() => admitGuardianRequest(options, message())).toThrow();
    expect(reserve).toHaveBeenCalledTimes(1);
  });

  it('permits explicit metered preflight without enabling repository delivery', () => {
    const { ledger } = fixture();
    ledger.changeMode('prepared', 'fixture');
    const options = {
      ledger,
      issue: 0,
      nonce: 'n'.repeat(48),
      deadlineEpochMs: Date.now() + 60_000,
      processGroup: () => '1',
      preflightDigest: digest(ledger.mandate()),
    };
    expect(admitGuardianRequest(options, message())).toBe(false);
    expect(ledger.mode()).toBe('prepared');
    expect(() => ledger.assertAuthorized('merge', 1)).toThrow();
    expect(() => admitGuardianRequest({ ...options, preflightDigest: 'stale' }, message())).toThrow(
      'preflight-authorization-changed',
    );
  });

  it('rejects an unowned reported child process', () => {
    const { ledger } = fixture();
    expect(() =>
      admitGuardianRequest(
        {
          ledger,
          issue: 0,
          nonce: 'n'.repeat(48),
          deadlineEpochMs: Date.now() + 60_000,
          processGroup: () => '1',
        },
        { ...message('spawned'), process: { pid: process.pid, pgid: '1', procStartToken: 'fake' } },
      ),
    ).toThrow('spawned-process-ownership-mismatch');
  });

  it.each(['pause', 'deadline'] as const)(
    'rechecks %s after a fresh pending sample before acknowledging admission',
    async (condition) => {
      const { ledger, root } = fixture();
      const started = deferred();
      const sample = deferred();
      const options = {
        ledger,
        issue: 0,
        nonce: 'n'.repeat(48),
        deadlineEpochMs: Date.now() + 5000,
        processGroup: () => '1',
        verifyProcessTree: () => {
          started.resolve();
          return sample.promise;
        },
      };
      const socketPath = path.join(root, 'admission.sock');
      const admission = await openGuardianAdmission(options, socketPath);
      try {
        const response = sendAdmission(socketPath);
        await started.promise;
        if (condition === 'pause') {
          ledger.changeMode('pausing', 'fixture');
        } else {
          options.deadlineEpochMs = Date.now() - 1;
        }
        sample.resolve();
        expect(await response).toBe('{"ok":false}\n');
      } finally {
        sample.resolve();
        await admission.close();
      }
    },
  );

  it('closes a pending admitted sampler without manufacturing a new blocker', async () => {
    const { ledger, root } = fixture();
    const started = deferred();
    const options = {
      ledger,
      issue: 0,
      nonce: 'n'.repeat(48),
      deadlineEpochMs: Date.now() + 5000,
      processGroup: () => '1',
      verifyProcessTree: (signal: AbortSignal) => {
        started.resolve();
        return new Promise<void>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(
                new StageProcessEvidenceError({
                  reason: 'cancelled',
                  exitCode: null,
                  signal: 'SIGKILL',
                }),
              );
            },
            { once: true },
          );
        });
      },
    };
    const socketPath = path.join(root, 'admission.sock');
    const admission = await openGuardianAdmission(options, socketPath);
    const connection = createConnection(socketPath);
    try {
      connection.write(`${JSON.stringify(message())}\n`);
      await started.promise;
      await admission.close();
      expect(ledger.get('execution-admission-blocker')).toBeUndefined();
      expect(ledger.mode()).toBe('active');
    } finally {
      connection.destroy();
    }
  });
});

describe('guardian repository ownership and lifetime', () => {
  it('refuses another live owner and reclaims only a demonstrated dead owner', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'guardian-owner-test-'));
    cleanups.push(() => {
      rmSync(directory, { recursive: true, force: true });
    });
    const owner = currentProcessOwner();
    const release = acquireRepositoryOwner(owner, directory, () => true);
    expect(() => acquireRepositoryOwner({ ...owner, id: 'other' }, directory, () => true)).toThrow(
      'live-repository-delivery-owner',
    );
    const nextRelease = acquireRepositoryOwner(
      { ...owner, id: 'replacement' },
      directory,
      () => false,
    );
    release();
    expect(
      readFileSync(path.join(directory, `${digest('eventbalancer/agent-quorum')}.owner`), 'utf8'),
    ).toContain('replacement');
    nextRelease();
  });

  it('meters harmless work once and releases its process ownership', async () => {
    const { ledger } = fixture();
    const status = await runGuardianStep(ledger, {
      command: { bin: process.execPath, args: ['-e', 'setTimeout(() => {}, 120)'] },
    });
    expect(status).toBe(0);
    expect(ledger.budget(0, Date.now()).dailyMeasuredMs).toBeGreaterThan(100);
    expect(ledger.get('open-permit')).toBeUndefined();
    expect(ledger.owner('step')).toBeUndefined();
    expect(ledger.get('owned-processes')).toEqual([]);
  });

  it('settles and extends a permit while a fresh process sample remains pending', async () => {
    const { ledger } = fixture();
    const read = vi.fn(delayedStageReader(1000));
    const settlement = ledger.settleActive.bind(ledger);
    const pendingAtCheckpoint: boolean[] = [];
    const settle = vi.spyOn(ledger, 'settleActive').mockImplementation((...args) => {
      pendingAtCheckpoint.push(
        read.mock.results.at(-1)?.type === 'return' &&
          read.mock.settledResults.at(-1)?.type === 'incomplete',
      );
      settlement(...args);
    });
    const status = await runGuardianStep(ledger, {
      command: { bin: process.execPath, args: ['-e', 'setTimeout(() => {}, 1500)'] },
      readStageProcesses: read,
    });
    expect(status).toBe(0);
    expect(settle.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(pendingAtCheckpoint[0]).toBe(true);
    expect(ledger.get('clock-blocker')).toBeUndefined();
    expect(ledger.budget(0, Date.now()).dailyMeasuredMs).toBeGreaterThan(1400);
    expect(ledger.get('open-permit')).toBeUndefined();
    expect(read.mock.calls.some(([, control]) => control.signal?.aborted === true)).toBe(true);
  });

  it('cancels pending process evidence before acknowledging pause or releasing ownership', async () => {
    const { ledger } = fixture();
    const read = vi.fn(delayedStageReader(2000));
    const timer = setTimeout(() => {
      ledger.changeMode('pausing', 'fixture');
    }, 300);
    try {
      const started = performance.now();
      const status = await runGuardianStep(ledger, {
        command: {
          bin: process.execPath,
          args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
        },
        readStageProcesses: read,
      });
      expect(status).not.toBe(0);
      expect(performance.now() - started).toBeLessThan(1200);
      expect(ledger.mode()).toBe('paused');
      expect(ledger.owner('step')).toBeUndefined();
      expect(read.mock.calls[0]?.[1].signal?.aborted).toBe(true);
      expect(ledger.get('execution-admission-blocker')).toBeUndefined();
    } finally {
      clearTimeout(timer);
    }
  });

  it('retains sanitized failed acquisition evidence and blocks without releasing a successful stage', async () => {
    const { ledger } = fixture();
    const evidence = { reason: 'exit', exitCode: 7, signal: null } as const;
    const read: StageProcessReader = (_group, control) => {
      return control.signal === undefined
        ? Promise.resolve([])
        : Promise.reject(new StageProcessEvidenceError(evidence));
    };
    await expect(
      runGuardianStep(ledger, {
        command: { bin: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
        readStageProcesses: read,
      }),
    ).rejects.toThrow('stage-process-evidence-unavailable');
    expect(ledger.mode()).toBe('blocked');
    expect(ledger.events()).toContainEqual(
      expect.objectContaining({
        kind: 'stage-process-evidence-failed',
        detail: { issue: 0, ...evidence },
      }),
    );
    expect(ledger.owner('step')).toBeUndefined();
  });

  it('retains ownership and the open reservation when final cleanup evidence is unavailable', async () => {
    const { ledger } = fixture();
    const read: StageProcessReader = (group, control) => {
      if (control.signal === undefined) {
        return Promise.reject(
          new StageProcessEvidenceError({
            reason: 'exit',
            exitCode: 7,
            signal: null,
          }),
        );
      }
      return Promise.resolve([
        { pid: Number(group), parentPid: process.pid, group: Number(group), state: 'S' },
      ]);
    };
    await expect(
      runGuardianStep(ledger, {
        command: { bin: process.execPath, args: ['-e', 'setTimeout(()=>{},120)'] },
        readStageProcesses: read,
      }),
    ).rejects.toThrow('stage-process-evidence-unavailable');
    expect(ledger.mode()).toBe('blocked');
    expect(ledger.get('cleanup-blocker')).toBe('stage-process-cleanup-unconfirmed');
    expect(ledger.owner('step')).toBeDefined();
    expect(ledger.get('open-permit')).toBeDefined();
  });

  it.each([
    { accounting: 'measured', elapsedMs: 0.25 },
    { accounting: 'reserved', elapsedMs: 0.25 },
    { accounting: 'measured', elapsedMs: 0.000001 },
  ] as const)(
    'admits a real child handoff after $elapsedMs ms of $accounting time without restoring allowance',
    async ({ accounting, elapsedMs }) => {
      const { ledger, root } = fixture();
      const realNow = Date.now.bind(Date);
      const started = realNow();
      const midday = nextDeliveryDay(started) - 12 * 60 * 60_000;
      vi.spyOn(Date, 'now').mockImplementation(() => midday + realNow() - started);
      const permit = ledger.reserveActive(
        0,
        0,
        accounting === 'measured' ? Date.now() : nextDeliveryDay(Date.now()) - elapsedMs,
        'fixture',
      );
      if (accounting === 'measured') {
        ledger.settleActive(permit.id, elapsedMs, 'fixture');
      } else {
        ledger.retainInterruptedPermit();
      }
      const original = ledger.budget(0, Date.now());
      expect(original.dailyMeasuredMs + original.dailyReservedMs).toBe(elapsedMs);
      const budget = vi.spyOn(ledger, 'budget');
      const output = path.join(root, 'accepted-handoff.json');
      const reader = new URL('../../src/runtime/execution-handoff.ts', import.meta.url).href;
      const program = `
        import { readFileSync, writeFileSync } from 'node:fs';
        import { setTimeout } from 'node:timers/promises';
        import { readExecutionHandoff } from ${JSON.stringify(reader)};
        await setTimeout(120);
        const file = process.env.AGENT_QUORUM_EXECUTION_CONTROL_FILE;
        const execution = readExecutionHandoff(file);
        const handoff = JSON.parse(readFileSync(file, 'utf8'));
        writeFileSync(${JSON.stringify(output)}, JSON.stringify({
          deadlineEpochMs: execution.deadlineEpochMs,
          handoffFile: file,
          socketPath: handoff.socketPath,
        }));
      `;
      const status = await runGuardianStep(ledger, {
        command: {
          bin: process.execPath,
          args: ['--import', import.meta.resolve('tsx'), '--input-type=module', '-e', program],
        },
      });
      expect(status, readFileSync(path.join(ledger.directory, 'worker.log'), 'utf8')).toBe(0);
      const accepted = JSON.parse(readFileSync(output, 'utf8')) as {
        deadlineEpochMs: number;
        handoffFile: string;
        socketPath: string;
      };
      const wallAnchor = budget.mock.calls[0]?.[1];
      expect(wallAnchor).toBeDefined();
      expect(accepted.deadlineEpochMs).toBe((wallAnchor ?? 0) + Math.floor(original.availableMs));
      expect(Number.isSafeInteger(accepted.deadlineEpochMs)).toBe(true);
      expect(ledger.budget(0, Date.now()).dailyMeasuredMs).toBeGreaterThan(
        original.dailyMeasuredMs,
      );
      expect(ledger.budget(0, Date.now()).dailyReservedMs).toBe(original.dailyReservedMs);
      expect(ledger.get('open-permit')).toBeUndefined();
      expect(ledger.owner('step')).toBeUndefined();
      expect(ledger.get('owned-processes')).toEqual([]);
      expect(existsSync(accepted.handoffFile)).toBe(false);
      expect(existsSync(accepted.socketPath)).toBe(false);
    },
  );

  it('kills an ignored-signal worker after authority is paused', async () => {
    const { ledger } = fixture();
    const timer = setTimeout(() => {
      ledger.changeMode('pausing', 'fixture pause');
    }, 300);
    try {
      const started = Date.now();
      const result = await runGuardianStep(ledger, {
        command: {
          bin: process.execPath,
          args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
        },
      });
      expect(result).not.toBe(0);
      expect(Date.now() - started).toBeLessThan(5000);
      expect(ledger.mode()).toBe('paused');
      expect(ledger.owner('step')).toBeUndefined();
    } finally {
      clearTimeout(timer);
    }
  });

  it('stops advancement when a provider leaves a reparented helper in the owned stage group', async () => {
    const { ledger } = fixture();
    const orphan = 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)';
    const provider = `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(orphan)}],{stdio:'ignore'});child.unref();`;
    const stage = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(provider)}],{stdio:'ignore'});setInterval(()=>{},1000);`;
    await expect(
      runGuardianStep(ledger, {
        command: { bin: process.execPath, args: ['-e', stage] },
      }),
    ).rejects.toThrow('orphaned-provider-process');
    expect(ledger.mode()).toBe('blocked');
    expect(ledger.get('execution-admission-blocker')).toMatchObject({
      code: 'orphaned-provider-process',
    });
    expect(ledger.owner('step')).toBeUndefined();
    expect(ledger.get('owned-processes')).toEqual([]);
  });

  it('stops within the final issue allowance and preserves the deferred stage', async () => {
    const { ledger } = fixture();
    ledger.saveIssue({
      number: 1,
      nodeId: 'I_1',
      title: 'Fixture',
      originalBody: '',
      fingerprint: 'fixture',
      stage: 'implement',
      baseSha: 'base',
      acceptance: [],
      decisions: [],
      dependencies: [],
      findingKeys: [],
    });
    ledger.set('current-issue', 1);
    const original = ledger.budget(1, Date.now());
    vi.spyOn(ledger, 'budget').mockReturnValue({ ...original, availableMs: 600.75 });
    const read = vi.fn(deadlineStageReader);
    const status = await runGuardianStep(ledger, {
      command: {
        bin: process.execPath,
        args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      },
      readStageProcesses: read,
    });
    expect(status).not.toBe(0);
    expect(ledger.issue(1)?.stage).toBe('deferred');
    expect(ledger.get('resume-stage:1')).toBe('implement');
    expect(ledger.get('pending-status:1')).toMatchObject({ blocker: 'issue-active-limit' });
    expect(ledger.get('current-issue')).toBe(0);
    expect(ledger.get('execution-admission-blocker')).toBeUndefined();
    expect(read.mock.calls[0]?.[1].signal).toBeDefined();
    vi.restoreAllMocks();
    expect(ledger.budget(1, Date.now()).issueMeasuredMs).toBeLessThan(700);
  });

  it('classifies a capped pending sample as daily exhaustion without a shared evidence blocker', async () => {
    const { ledger } = fixture();
    const original = ledger.budget(0, Date.now());
    vi.spyOn(ledger, 'budget').mockReturnValue({ ...original, availableMs: 600.75 });
    const read = vi.fn(deadlineStageReader);
    const status = await runGuardianStep(ledger, {
      command: {
        bin: process.execPath,
        args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      },
      readStageProcesses: read,
    });
    expect(status).not.toBe(0);
    expect(ledger.mode()).toBe('daily-limit');
    expect(ledger.get('daily-resume-after')).toBe(nextDeliveryDay(Date.now()));
    expect(ledger.get('execution-admission-blocker')).toBeUndefined();
    expect(read.mock.calls[0]?.[1].signal).toBeDefined();
    expect(ledger.get('open-permit')).toBeUndefined();
    vi.restoreAllMocks();
    expect(ledger.budget(0, Date.now()).dailyMeasuredMs).toBeLessThan(700);
  });

  it('blocks a discontinuous wall clock while using a monotonic hard deadline', async () => {
    const { ledger } = fixture();
    const realNow = Date.now.bind(Date);
    const timer = setTimeout(() => {
      vi.spyOn(Date, 'now').mockImplementation(() => realNow() - 60_000);
    }, 150);
    try {
      await runGuardianStep(ledger, {
        command: { bin: process.execPath, args: ['-e', 'setInterval(()=>{},1000)'] },
      });
      expect(ledger.mode()).toBe('blocked');
      expect(ledger.get('clock-blocker')).toBe('wall-clock-discontinuity');
      expect(ledger.owner('step')).toBeUndefined();
    } finally {
      clearTimeout(timer);
    }
  });

  it('pins the supervised daemon to the frozen runtime and escapes plist data', () => {
    const { mandate } = fixture();
    const document = launchAgentDocument(mandate, '/tmp/a&b', '/fixture/node');
    expect(document).toContain('dist/delivery/main.js');
    expect(document).toContain('<string>daemon</string>');
    expect(document).toContain('/tmp/a&amp;b');
    expect(document).toContain('<key>SuccessfulExit</key><false/>');
  });
});
