import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { digest } from '../../src/delivery/contract.js';
import {
  acquireRepositoryOwner,
  admitGuardianRequest,
  currentProcessOwner,
  launchAgentDocument,
  runGuardianStep,
} from '../../src/delivery/guardian.js';
import { deliveryFixture } from '../helpers/delivery.js';

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
    vi.spyOn(ledger, 'budget').mockReturnValue({ ...original, availableMs: 600 });
    const status = await runGuardianStep(ledger, {
      command: {
        bin: process.execPath,
        args: ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
      },
    });
    expect(status).not.toBe(0);
    expect(ledger.issue(1)?.stage).toBe('deferred');
    expect(ledger.get('resume-stage:1')).toBe('implement');
    expect(ledger.get('pending-status:1')).toMatchObject({ blocker: 'issue-active-limit' });
    expect(ledger.get('current-issue')).toBe(0);
    vi.restoreAllMocks();
    expect(ledger.budget(1, Date.now()).issueMeasuredMs).toBeLessThan(700);
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
