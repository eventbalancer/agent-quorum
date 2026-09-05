import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runLaunchCli } from '../../src/cli/launch.js';
import { runPlanLoopCli } from '../../src/stages/plan/run.js';
import { acquireWorkdirLock } from '../../src/runtime/workdir-lock.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'plan-owner-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('planning entrypoint ownership', () => {
  it('rejects direct and detached overlap before log rotation or artifact writes', async () => {
    const work = path.join(root, 'work');
    const input = path.join(root, 'input.md');
    mkdirSync(work);
    writeFileSync(input, '# Fixture');
    writeFileSync(path.join(work, 'run.log'), 'owned run log');
    writeFileSync(path.join(work, 'plan.final.md'), 'owned plan');
    const lock = acquireWorkdirLock(work);
    try {
      const overrides = { home: path.join(root, 'home'), workDir: work };
      await expect(runPlanLoopCli([input], overrides)).rejects.toThrow('owned');
      await expect(runLaunchCli([input], () => undefined, overrides)).rejects.toThrow('owned');
      expect(readFileSync(path.join(work, 'run.log'), 'utf8')).toBe('owned run log');
      expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe('owned plan');
      expect(readdirSync(work).sort()).toEqual(['plan.final.md', 'run.log']);
    } finally {
      lock.release();
    }
  });
});
