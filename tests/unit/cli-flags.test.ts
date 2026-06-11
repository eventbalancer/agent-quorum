import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseRunArgs } from '../../src/cli/run.js';
import { runInterveneCli } from '../../src/cli/intervene.js';
import { runLaunchCli } from '../../src/cli/launch.js';
import { HaltError } from '../../src/runtime/halt.js';
import { captureStderr, type StderrCapture } from '../helpers/harness.js';

let tmp: string;
let capture: StderrCapture;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-flags.'));
  writeFileSync(path.join(tmp, 'input.md'), '# X\n');
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  rmSync(tmp, { recursive: true, force: true });
});

function haltCode(fn: () => unknown): number {
  try {
    fn();
    return 0;
  } catch (error) {
    if (error instanceof HaltError) {
      return error.exitCode;
    }
    throw error;
  }
}

describe('core run flag parsing', () => {
  it('accepts both space and = forms and the -- terminator', () => {
    const input = path.join(tmp, 'input.md');
    expect(parseRunArgs(['--max-iters', '4', input]).cli.maxIters).toBe('4');
    expect(parseRunArgs(['--iters=2', input]).cli.maxIters).toBe('2');
    expect(parseRunArgs(['--max-iters=9', input]).cli.maxIters).toBe('9');
    expect(parseRunArgs(['--effort=max', input]).cli.effort).toBe('max');
    expect(parseRunArgs(['--fix', input]).cli.fix).toBe('1');
    expect(parseRunArgs(['--translate', input]).cli.translate).toBe('1');
    expect(parseRunArgs(['--locale', 'ru', input]).cli.locale).toBe('ru');
    expect(parseRunArgs(['--locale=pt-BR', input]).cli.locale).toBe('pt-BR');
    const prompt = parseRunArgs(['--prompt', input]);
    expect(prompt.mode).toBe('prompt');
    expect(haltCode(() => parseRunArgs([input, '--', 'ignored.md']))).toBe(0);
  });

  it('rejects bad values with reference messages', () => {
    const input = path.join(tmp, 'input.md');
    expect(haltCode(() => parseRunArgs(['--iters', 'x', input]))).toBe(1);
    expect(capture.text()).toContain('--iters expects a positive integer');
    expect(haltCode(() => parseRunArgs(['--iters=x', input]))).toBe(1);
    expect(haltCode(() => parseRunArgs(['--effort']))).toBe(1);
    expect(haltCode(() => parseRunArgs(['--locale']))).toBe(1);
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(haltCode(() => parseRunArgs(['-h']))).toBe(0);
    stdoutSpy.mockRestore();
    expect(haltCode(() => parseRunArgs(['--prompt']))).toBe(1);
    expect(haltCode(() => parseRunArgs([input, 'extra.md']))).toBe(1);
    expect(capture.text()).toContain('unexpected arg: extra.md');
    expect(haltCode(() => parseRunArgs(['--']))).toBe(1);
  });
});

describe('intervene flag parsing', () => {
  it('accepts = forms, -- collection, and rejects empty stdin-free messages', () => {
    const work = path.join(tmp, 'work');
    mkdirSync(work);
    expect(
      runInterveneCli([`--work=${work}`, '--target=fixer', '--', 'a', '-b', 'c'], () => {
        /* drop */
      }),
    ).toBe(0);
    expect(haltCode(() => runInterveneCli(['--work', work, '-h'], () => undefined))).toBe(0);
    expect(haltCode(() => runInterveneCli(['--work', work], () => undefined))).toBe(1);
    expect(haltCode(() => runInterveneCli(['--target', 'critic', 'x'], () => undefined))).toBe(1);
    expect(haltCode(() => runInterveneCli(['--work', ''], () => undefined))).toBe(1);
  });
});

describe('launch flag parsing', () => {
  it('rejects missing values with exit 2 and accepts pass-through flags', async () => {
    const codes: number[] = [];
    for (const args of [['--iters'], ['--prompt'], ['--effort'], ['--locale'], ['x', 'y']]) {
      try {
        await runLaunchCli(args, () => undefined);
        codes.push(0);
      } catch (error) {
        codes.push(error instanceof HaltError ? error.exitCode : -1);
      }
    }
    expect(codes).toEqual([2, 2, 2, 2, 2]);
    expect((await runLaunchCli(['--help'], () => undefined)).exitCode).toBe(0);
  });
});
