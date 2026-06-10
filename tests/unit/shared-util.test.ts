import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isJsonObject, jqAlt } from '../../src/core/json.js';
import { countNewlines, fileLineCount, nonEmptyFile } from '../../src/runtime/files.js';
import { killTree, ownPgid, spawnDetached, waitForExit } from '../../src/runtime/exec.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-shared.'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('json helpers', () => {
  it('isJsonObject accepts plain objects only', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject([])).toBe(false);
    expect(isJsonObject(null)).toBe(false);
    expect(isJsonObject('x')).toBe(false);
    expect(isJsonObject(undefined)).toBe(false);
  });

  it('jqAlt falls through on null, undefined, and false only', () => {
    expect(jqAlt(null, 'fb')).toBe('fb');
    expect(jqAlt(undefined, 'fb')).toBe('fb');
    expect(jqAlt(false, 'fb')).toBe('fb');
    expect(jqAlt('', 'fb')).toBe('');
    expect(jqAlt(0, 'fb')).toBe(0);
    expect(jqAlt('value', 'fb')).toBe('value');
  });
});

describe('file helpers', () => {
  it('nonEmptyFile mirrors bash [[ -s ]]', () => {
    const missing = path.join(tmp, 'missing');
    const empty = path.join(tmp, 'empty');
    const full = path.join(tmp, 'full');
    writeFileSync(empty, '');
    writeFileSync(full, 'x');
    expect(nonEmptyFile(missing)).toBe(false);
    expect(nonEmptyFile(empty)).toBe(false);
    expect(nonEmptyFile(full)).toBe(true);
  });

  it('counts newlines like wc -l', () => {
    expect(countNewlines('')).toBe(0);
    expect(countNewlines('one line, no newline')).toBe(0);
    expect(countNewlines('a\nb\n')).toBe(2);
    const file = path.join(tmp, 'lines');
    writeFileSync(file, 'a\nb\nc');
    expect(fileLineCount(file)).toBe(2);
  });
});

describe('session argument edge branches', () => {
  it('returns no args for stateless and not-yet-captured sessions', async () => {
    const { claudeSessionArgs, cursorSessionArgs } = await import('../../src/providers/session.js');
    expect(claudeSessionArgs('')).toEqual({ args: [], wasResume: false });
    expect(cursorSessionArgs('')).toEqual({ args: [], wasResume: false });
    const emptySession = path.join(tmp, 'cursor.session');
    writeFileSync(emptySession, '');
    expect(cursorSessionArgs(emptySession)).toEqual({ args: [], wasResume: false });
  });
});

describe('scratch collision branch', () => {
  it('retries on an EEXIST collision via the wx flag', async () => {
    const { Scratch } = await import('../../src/runtime/scratch.js');
    const scratch = Scratch.create('collision');
    const seen = new Set<string>();
    for (let i = 0; i < 32; i += 1) {
      seen.add(scratch.file());
    }
    expect(seen.size).toBe(32);
    scratch.sweep();
  });
});

describe('process helpers', () => {
  it('resolves the own process group id', () => {
    expect(ownPgid()).toMatch(/^[0-9]*$/);
  });

  it('maps SIGKILL terminations to 137 and tolerates dead trees', async () => {
    const child = spawnDetached('sleep', ['30'], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 100));
    killTree(child, 'SIGKILL');
    expect(await waitForExit(child)).toBe(137);
    killTree(child, 'SIGTERM');
  });
});
