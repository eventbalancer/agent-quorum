import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configStorePath,
  ensureStoreHome,
  mergeConfigStore,
  readConfigStore,
  readSecretsStore,
  secretsStorePath,
  writeConfigStore,
  writeSecretsStore,
} from '../../src/core/store.js';
import type { DeepPartial, OperatorConfig } from '../../src/core/config.js';
import { HaltError } from '../../src/runtime/halt.js';

let home: string;

function mode(file: string): number {
  return statSync(file).mode & 0o777;
}

beforeEach(() => {
  home = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-storetest.'));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

describe('store permissions', () => {
  it('writes secrets.json 0600 under a 0700 home', () => {
    rmSync(home, { recursive: true, force: true });
    writeSecretsStore(home, { telegramBotToken: 'tok' });
    expect(mode(home)).toBe(0o700);
    expect(mode(secretsStorePath(home))).toBe(0o600);
    expect(readSecretsStore(home).telegramBotToken).toBe('tok');
  });

  it('ensureStoreHome hardens a pre-existing 0755 home to 0700', () => {
    chmodSync(home, 0o755);
    expect(mode(home)).toBe(0o755);
    ensureStoreHome(home);
    expect(mode(home)).toBe(0o700);
  });

  it('readSecretsStore chmods a pre-existing 0644 secrets.json to 0600 and hardens the home', () => {
    chmodSync(home, 0o755);
    const file = secretsStorePath(home);
    writeFileSync(file, JSON.stringify({ telegramBotToken: 'tok' }), { mode: 0o644 });
    chmodSync(file, 0o644);
    expect(mode(file)).toBe(0o644);
    expect(readSecretsStore(home).telegramBotToken).toBe('tok');
    expect(mode(file)).toBe(0o600);
    expect(mode(home)).toBe(0o700);
  });

  it('readSecretsStore leaves a home with no secrets.json untouched', () => {
    chmodSync(home, 0o755);
    expect(readSecretsStore(home)).toEqual({});
    expect(mode(home)).toBe(0o755);
  });

  it('ensureStoreHome leaves an already owner-only home untouched', () => {
    chmodSync(home, 0o700);
    ensureStoreHome(home);
    expect(mode(home)).toBe(0o700);
  });
});

describe('store malformed handling', () => {
  it('missing files resolve to empty defaults', () => {
    expect(readConfigStore(home)).toEqual({});
    expect(readSecretsStore(home)).toEqual({});
  });

  it('malformed config.json raises a HaltError naming the path', () => {
    const file = path.join(home, 'config.json');
    writeFileSync(file, '{ not json');
    try {
      readConfigStore(home);
      expect.unreachable('expected HaltError');
    } catch (error) {
      expect(error).toBeInstanceOf(HaltError);
      expect((error as HaltError).message).toContain(file);
    }
  });

  it('malformed secrets.json raises a HaltError without echoing the token', () => {
    const file = secretsStorePath(home);
    writeFileSync(file, '{ "telegramBotToken": "SUPER-SECRET-TOKEN"', { mode: 0o600 });
    try {
      readSecretsStore(home);
      expect.unreachable('expected HaltError');
    } catch (error) {
      expect(error).toBeInstanceOf(HaltError);
      const message = (error as HaltError).message;
      expect(message).toContain(file);
      expect(message).not.toContain('SUPER-SECRET-TOKEN');
    }
  });

  it('wrong-shaped secrets.json (non-string token) raises a HaltError naming the path', () => {
    const file = secretsStorePath(home);
    writeFileSync(file, JSON.stringify({ telegramBotToken: 12345 }), { mode: 0o600 });
    try {
      readSecretsStore(home);
      expect.unreachable('expected HaltError');
    } catch (error) {
      expect(error).toBeInstanceOf(HaltError);
      expect((error as HaltError).message).toContain(file);
    }
  });
});

describe('mergeConfigStore', () => {
  it('deep-merges: disjoint subtrees survive and shared objects recurse', () => {
    writeConfigStore(home, { settings: { iters: 7 }, telegram: { chatId: 'OLD', clarify: '1' } });
    mergeConfigStore(home, { telegram: { chatId: 'NEW' } });
    expect(readConfigStore(home)).toEqual({
      settings: { iters: 7 },
      telegram: { chatId: 'NEW', clarify: '1' },
    });
  });

  it('treats a missing config.json as an empty base', () => {
    mergeConfigStore(home, { telegram: { chatId: 'X' } });
    expect(readConfigStore(home)).toEqual({ telegram: { chatId: 'X' } });
  });

  it('lets the patch win on a scalar/object type mismatch and replaces arrays', () => {
    writeFileSync(configStorePath(home), `${JSON.stringify({ a: { nested: 1 }, list: [1, 2] })}\n`);
    mergeConfigStore(home, { a: 5, list: [3] } as unknown as DeepPartial<OperatorConfig>);
    expect(readConfigStore(home)).toEqual({ a: 5, list: [3] });
  });

  it('preserves unknown keys not named in the patch', () => {
    writeFileSync(
      configStorePath(home),
      `${JSON.stringify({ experimentalUnknownKey: { keep: true } })}\n`,
    );
    mergeConfigStore(home, { telegram: { chatId: '9' } });
    expect(readConfigStore(home)).toEqual({
      experimentalUnknownKey: { keep: true },
      telegram: { chatId: '9' },
    });
  });

  it('keeps writeConfigStore a full rewrite (no merge)', () => {
    writeConfigStore(home, { settings: { iters: 7 }, telegram: { chatId: 'OLD' } });
    writeConfigStore(home, { telegram: { chatId: 'Z' } });
    expect(readConfigStore(home)).toEqual({ telegram: { chatId: 'Z' } });
  });
});
