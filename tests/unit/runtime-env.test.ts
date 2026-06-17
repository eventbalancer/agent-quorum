import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPackageRoot } from '../../src/runtime/env.js';

let root: string;
let otherDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-envtest.'));
  otherDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-envother.'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(otherDir, { recursive: true, force: true });
});

describe('findPackageRoot', () => {
  it('resolves a directory holding package.json and a skills/ directory', () => {
    writeFileSync(path.join(root, 'package.json'), '{}\n');
    mkdirSync(path.join(root, 'skills'));
    expect(findPackageRoot(root)).toBe(root);
  });

  it('does not match a directory with package.json but no skills/ directory', () => {
    writeFileSync(path.join(otherDir, 'package.json'), '{}\n');
    expect(() => findPackageRoot(otherDir)).toThrow(/package root not found/);
  });
});
