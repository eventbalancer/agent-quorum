import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findPackageRoot, loadAgentQuorumDotenv } from '../../src/runtime/env.js';

const LEGACY_CONFIG_NAME = `${['plan', 'loop'].join('-')}.json`;

const TRACKED_KEYS = [
  'PL_TEST_PLAIN',
  'PL_TEST_EXPORT',
  'PL_TEST_DQ',
  'PL_TEST_SQ',
  'PL_TEST_REAL',
  'PL_TEST_EMPTY',
  'PL_TEST_CRLF',
  'PL_TEST_NOEQ',
  'PL_TEST_SPACED',
  'PL_TEST_OTHERDIR',
];

let root: string;
let otherDir: string;

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-envtest.'));
  otherDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-envother.'));
  for (const key of TRACKED_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(otherDir, { recursive: true, force: true });
  for (const key of TRACKED_KEYS) {
    Reflect.deleteProperty(process.env, key);
  }
});

describe('loadAgentQuorumDotenv', () => {
  it('loads keys with reference parsing semantics', () => {
    writeFileSync(
      path.join(root, '.env'),
      [
        '# comment',
        '',
        'PL_TEST_PLAIN=alpha',
        'export PL_TEST_EXPORT=beta',
        'PL_TEST_DQ="quoted value"',
        "PL_TEST_SQ='single'",
        'PL_TEST_CRLF=gamma\r',
        'PL_TEST_NOEQ',
        ' PL_TEST_SPACED =delta',
        '1BADKEY=skipped',
      ].join('\n'),
    );
    loadAgentQuorumDotenv(root);
    expect(process.env.PL_TEST_PLAIN).toBe('alpha');
    expect(process.env.PL_TEST_EXPORT).toBe('beta');
    expect(process.env.PL_TEST_DQ).toBe('quoted value');
    expect(process.env.PL_TEST_SQ).toBe('single');
    expect(process.env.PL_TEST_CRLF).toBe('gamma');
    expect(process.env.PL_TEST_NOEQ).toBe('PL_TEST_NOEQ');
    expect(process.env.PL_TEST_SPACED).toBe('delta');
    expect(process.env['1BADKEY']).toBeUndefined();
  });

  it('lets real environment variables win, treating empty string as unset', () => {
    writeFileSync(
      path.join(root, '.env'),
      ['PL_TEST_REAL=fromfile', 'PL_TEST_EMPTY=fromfile'].join('\n'),
    );
    process.env.PL_TEST_REAL = 'fromenv';
    process.env.PL_TEST_EMPTY = '';
    loadAgentQuorumDotenv(root);
    expect(process.env.PL_TEST_REAL).toBe('fromenv');
    expect(process.env.PL_TEST_EMPTY).toBe('fromfile');
  });

  it('is a no-op when the package root has no .env', () => {
    expect(() => {
      loadAgentQuorumDotenv(root);
    }).not.toThrow();
  });

  it('never reads a .env beside an overridden config file (Finding F3)', () => {
    writeFileSync(path.join(otherDir, '.env'), 'PL_TEST_OTHERDIR=leaked\n');
    writeFileSync(path.join(otherDir, 'agent-quorum.json'), '{}\n');
    process.env.AGENT_QUORUM_CONFIG_FILE = path.join(otherDir, 'agent-quorum.json');
    try {
      loadAgentQuorumDotenv(root);
      expect(process.env.PL_TEST_OTHERDIR).toBeUndefined();
    } finally {
      delete process.env.AGENT_QUORUM_CONFIG_FILE;
    }
  });
});

describe('findPackageRoot', () => {
  it('resolves a directory holding agent-quorum.json and package.json', () => {
    writeFileSync(path.join(root, 'agent-quorum.json'), '{}\n');
    writeFileSync(path.join(root, 'package.json'), '{}\n');
    expect(findPackageRoot(root)).toBe(root);
  });

  it('does not match a directory holding only the legacy config filename', () => {
    writeFileSync(path.join(otherDir, LEGACY_CONFIG_NAME), '{}\n');
    writeFileSync(path.join(otherDir, 'package.json'), '{}\n');
    expect(() => findPackageRoot(otherDir)).toThrow(/package root not found/);
  });
});
