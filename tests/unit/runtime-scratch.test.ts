import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Scratch } from '../../src/runtime/scratch.js';

describe('Scratch', () => {
  it('creates a base-prefixed directory under tmpdir, hands out unique files, sweeps', () => {
    const scratch = Scratch.create('mybase');
    expect(scratch.dir.startsWith(path.join(os.tmpdir(), 'plan-loop-mybase.'))).toBe(true);
    expect(existsSync(scratch.dir)).toBe(true);

    const a = scratch.file();
    const b = scratch.file();
    expect(a).not.toBe(b);
    expect(path.dirname(a)).toBe(scratch.dir);
    expect(path.basename(a).startsWith('tmp.')).toBe(true);
    expect(existsSync(a)).toBe(true);
    expect(existsSync(b)).toBe(true);

    scratch.sweep();
    expect(existsSync(scratch.dir)).toBe(false);
  });

  it('sweep tolerates an already-removed directory', () => {
    const scratch = Scratch.create('gone');
    scratch.sweep();
    expect(() => {
      scratch.sweep();
    }).not.toThrow();
  });
});
