import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, describe, expect, it } from 'vitest';
import { admitGuardianRequest } from '../../src/delivery/guardian.js';
import { spawnControlled, type ExecutionProcess } from '../../src/runtime/execution-control.js';
import { spawnExecutionStartGate } from '../../src/runtime/execution-start-gate.js';
import { commandOf, isAlive, pgidOf, procStartToken } from '../../src/runtime/proc.js';
import { spawnOwned, terminateOwned, waitForExit } from '../../src/runtime/exec.js';
import { deliveryFixture } from '../helpers/delivery.js';

const children: ChildProcess[] = [];
const cleanups: (() => void)[] = [];
afterEach(async () => {
  await Promise.all(children.splice(0).map((child) => terminateOwned(child, 0)));
  for (const cleanup of cleanups.splice(0).reverse()) {
    cleanup();
  }
});

function fixture() {
  const result = deliveryFixture();
  cleanups.push(() => {
    result.ledger.close();
    rmSync(result.root, { recursive: true, force: true });
  });
  const marker = path.join(result.root, 'command-ran');
  const args = [
    '-e',
    `require('node:fs').writeFileSync(${JSON.stringify(marker)},String(process.pid))`,
  ];
  const admission = (child: ExecutionProcess) => {
    return admitGuardianRequest(
      {
        ledger: result.ledger,
        issue: 0,
        nonce: 'n'.repeat(48),
        deadlineEpochMs: Date.now() + 5000,
        processGroup: () => pgidOf(process.pid),
      },
      {
        version: 1,
        requestId: 'fixture-spawned-request',
        type: 'spawned',
        nonce: 'n'.repeat(48),
        attempt: { command: child.command, cwd: child.cwd },
        process: child,
      },
    );
  };
  return { ...result, marker, args, admission };
}

describe('supervised execution start gate', () => {
  it('keeps a short command alive and unable to act until strict guardian registration succeeds', async () => {
    const { root, marker, args, admission } = fixture();
    let registered: ExecutionProcess | undefined;
    const child = await spawnControlled(
      process.execPath,
      args,
      { cwd: root, stdio: 'ignore' },
      {
        processGroup: 'shared',
        deadlineEpochMs: Date.now() + 5000,
        terminateGraceMs: 0,
        onSpawn: async (identity) => {
          registered = identity;
          await sleep(100);
          expect(isAlive(identity.pid)).toBe(true);
          expect(existsSync(marker)).toBe(false);
          expect(procStartToken(identity.pid)).toBe(identity.procStartToken);
          admission(identity);
        },
      },
    );
    children.push(child);
    expect(child.pid).toBe(registered?.pid);
    expect(await waitForExit(child)).toBe(0);
    expect(Number(readFileSync(marker, 'utf8'))).toBe(registered?.pid);
  });

  it('preserves PATH lookup, cwd, literal argv, argv0, environment, and normal stdio', async () => {
    const { root, admission } = fixture();
    const bin = path.join(root, 'bin');
    mkdirSync(bin);
    symlinkSync(process.execPath, path.join(bin, 'fixture-node'));
    const hookMarker = path.join(root, 'hook-ran');
    const hook = path.join(root, 'hook.mjs');
    writeFileSync(
      hook,
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(hookMarker)},'ran');`,
    );
    const env = {
      PATH: bin,
      NODE_OPTIONS: `--import ${hook}`,
      TASK_PRIVATE_VALUE: 'private-gate-fixture-value',
      PWD: '/supplied-pwd',
      OLDPWD: '/supplied-oldpwd',
      IFS: 'literal-ifs',
      SHLVL: '5',
    };
    const program = `let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{process.stdout.write(JSON.stringify({argv:process.argv.slice(1),argv0:process.argv0,env:process.env,cwd:process.cwd(),input}));process.stderr.write('stderr-preserved');});`;
    const args = ['-e', program, '', 'literal "quotes" $()\ntext'];
    const baseline = spawnOwned(process.execPath, args, {
      cwd: root,
      argv0: 'custom-argv0',
      env,
      stdio: 'pipe',
    });
    children.push(baseline);
    let expected = '';
    baseline.stdout?.on('data', (chunk: Buffer) => {
      expected += chunk.toString();
    });
    baseline.stdin?.end('stdin-preserved');
    expect(await waitForExit(baseline)).toBe(0);
    rmSync(hookMarker);
    const child = await spawnControlled(
      'fixture-node',
      args,
      { cwd: root, argv0: 'custom-argv0', env, stdio: 'pipe' },
      {
        processGroup: 'shared',
        deadlineEpochMs: Date.now() + 5000,
        terminateGraceMs: 0,
        onSpawn: (identity) => {
          expect(existsSync(hookMarker)).toBe(false);
          expect(commandOf(identity.pid)).not.toContain(env.TASK_PRIVATE_VALUE);
          expect(commandOf(identity.pid)).not.toContain('custom-argv0');
          admission(identity);
        },
      },
    );
    children.push(child);
    let output = '';
    let errors = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      errors += chunk.toString();
    });
    child.stdin?.end('stdin-preserved');
    expect(await waitForExit(child), errors).toBe(0);
    expect(JSON.parse(output)).toEqual(JSON.parse(expected));
    expect(errors).toBe('stderr-preserved');
    expect(existsSync(hookMarker)).toBe(true);
  });

  it.each(['rejected', 'recycled', 'cancelled'] as const)(
    'reaps the gate without acting after %s admission',
    async (failure) => {
      const { root, marker, args, admission } = fixture();
      const abort = new AbortController();
      let pid = 0;
      await expect(
        spawnControlled(
          process.execPath,
          args,
          { cwd: root, stdio: 'ignore' },
          {
            processGroup: 'shared',
            signal: abort.signal,
            deadlineEpochMs: Date.now() + 5000,
            terminateGraceMs: 0,
            onSpawn: (identity) => {
              pid = identity.pid;
              if (failure === 'recycled') {
                admission({ ...identity, procStartToken: 'recycled-process' });
              } else if (failure === 'cancelled') {
                abort.abort();
              } else {
                throw new Error('fixture admission rejected');
              }
            },
          },
        ),
      ).rejects.toThrow(
        failure === 'recycled'
          ? 'spawned-process-ownership-mismatch'
          : failure === 'cancelled'
            ? 'aborted'
            : 'fixture admission rejected',
      );
      expect(pid).toBeGreaterThan(0);
      expect(isAlive(pid)).toBe(false);
      expect(existsSync(marker)).toBe(false);
    },
  );

  it('closes the private gate descriptor before exec', async () => {
    const { root, admission } = fixture();
    const child = await spawnControlled(
      '/bin/sh',
      ['-c', 'test ! -e /dev/fd/3'],
      { cwd: root, stdio: 'ignore' },
      {
        processGroup: 'shared',
        onSpawn: (identity) => {
          admission(identity);
        },
      },
    );
    children.push(child);
    expect(await waitForExit(child)).toBe(0);
  });

  it('reaps a gate whose registration misses the deadline and ignores its late acknowledgement', async () => {
    const { root, marker, args } = fixture();
    let acknowledge: (() => void) | undefined;
    const registration = new Promise<void>((resolve) => {
      acknowledge = resolve;
    });
    let pid = 0;
    await expect(
      spawnControlled(
        process.execPath,
        args,
        { cwd: root, stdio: 'ignore' },
        {
          processGroup: 'shared',
          deadlineEpochMs: Date.now() + 1000,
          terminateGraceMs: 0,
          onSpawn: (identity) => {
            pid = identity.pid;
            return registration;
          },
        },
      ),
    ).rejects.toThrow('deadline');
    expect(pid).toBeGreaterThan(0);
    expect(isAlive(pid)).toBe(false);
    acknowledge?.();
    await sleep(25);
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects release through a destroyed pipe and exits without executing the target', async () => {
    const { root, marker, args } = fixture();
    const gate = spawnExecutionStartGate(process.execPath, args, { cwd: root, stdio: 'ignore' });
    children.push(gate.child);
    gate.close();
    await expect(gate.release()).rejects.toThrow();
    expect(await waitForExit(gate.child)).toBe(127);
    expect(isAlive(gate.child.pid ?? 0)).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it.each<SpawnOptions>([
    { shell: true },
    { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] },
    { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] },
  ])('rejects unsupported supervised process options %j', async (options) => {
    const { root, marker, args } = fixture();
    await expect(
      spawnControlled(
        process.execPath,
        args,
        { ...options, cwd: root },
        {
          processGroup: 'shared',
          onSpawn: () => {
            throw new Error('unexpected spawn');
          },
        },
      ),
    ).rejects.toThrow('requires direct argv and only stdin/stdout/stderr');
    expect(existsSync(marker)).toBe(false);
  });
});
