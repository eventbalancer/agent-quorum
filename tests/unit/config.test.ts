import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveConfig, runnersInUse, type RunSettings } from '../../src/core/config.js';
import type { JsonObject } from '../../src/core/json.js';
import { captureStderr } from '../helpers/harness.js';

let tmp: string;

function writeStore(config: JsonObject): void {
  writeFileSync(path.join(tmp, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
}

function resolvedSettings(env: NodeJS.ProcessEnv = {}): RunSettings {
  return resolveConfig({ env, home: tmp }).config.settings;
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-configtest.'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('resolveConfig validation', () => {
  it('halts on a non-positive iters', () => {
    writeStore({ settings: { iters: 0 } });
    const capture = captureStderr();
    try {
      expect(() => resolvedSettings()).toThrow(/iters must be a positive integer/);
    } finally {
      capture.restore();
    }
  });

  it('halts on a non-boolean fix', () => {
    writeStore({ settings: { fix: 'maybe' } });
    const capture = captureStderr();
    try {
      expect(() => resolvedSettings()).toThrow(/settings\.fix must be true or false/);
    } finally {
      capture.restore();
    }
  });

  it('halts on an invalid quality', () => {
    writeStore({ settings: { quality: 'medium' } });
    const capture = captureStderr();
    try {
      expect(() => resolvedSettings()).toThrow(
        /settings\.quality must be quick, balanced, or thorough/,
      );
    } finally {
      capture.restore();
    }
  });

  it('halts on an invalid runner', () => {
    writeStore({ roles: { critic: { runner: 'gemini', model: 'm' } } });
    const capture = captureStderr();
    try {
      expect(() => resolveConfig({ env: {}, home: tmp })).toThrow(/invalid runner 'gemini'/);
    } finally {
      capture.restore();
    }
  });

  it('halts on an invalid locale tag', () => {
    writeStore({ settings: { locale: '../ru' } });
    const capture = captureStderr();
    try {
      expect(() => resolvedSettings()).toThrow(/settings\.locale/);
    } finally {
      capture.restore();
    }
  });
});

describe('resolveConfig role matrix', () => {
  it('an env runner override beats the store and preserves the store model', () => {
    writeStore({ roles: { critic: { runner: 'codex', model: 'gpt-5.5' } } });
    const capture = captureStderr();
    try {
      const { config, provenance } = resolveConfig({
        env: { AGENT_QUORUM_CRITIC_RUNNER: 'claude' },
        home: tmp,
      });
      expect(config.matrix.critic.runner).toBe('claude');
      expect(config.matrix.critic.model).toBe('gpt-5.5');
      expect(provenance.get('roles.critic.runner')).toBe('env');
      expect(provenance.get('roles.critic.model')).toBe('store');
    } finally {
      capture.restore();
    }
  });

  it('falls through to DEFAULT_CONFIG roles when the store is silent', () => {
    const { config } = resolveConfig({ env: {}, home: tmp });
    expect(config.matrix.critic).toEqual({ runner: 'codex', model: 'gpt-5.5', reasoning: 'high' });
    expect(config.matrix.creator.runner).toBe('claude');
    expect(runnersInUse(config.matrix, 0, 0, 0)).toEqual(['codex', 'claude']);
    expect(runnersInUse(config.matrix, 0, 0, 1)).toEqual(['codex', 'claude']);
  });
});

describe('resolveConfig role permissions', () => {
  it('resolves tool permissions from the store in array and string forms', () => {
    writeStore({
      roles: {
        creator: {
          runner: 'claude',
          model: 'claude-opus-4-8',
          createTools: ['Read', 'Grep', 'Glob', 'Bash'],
          createDisallowedTools: 'Write,Edit',
          updateTools: 'Read',
          updateDisallowedTools: 'Write,Bash',
        },
      },
    });
    const { config } = resolveConfig({ env: {}, home: tmp });
    expect(config.permissions.creator.createTools).toBe('Read,Grep,Glob,Bash');
    expect(config.permissions.creator.createDisallowedTools).toBe('Write,Edit');
    expect(config.permissions.critic.tools).toBe('Read,Grep,Glob');
  });

  it('an empty store tool field falls through to the default', () => {
    writeStore({
      roles: { reviewer: { runner: 'codex', model: 'm', disallowedTools: [] } },
    });
    const { config, provenance } = resolveConfig({ env: {}, home: tmp });
    expect(config.permissions.reviewer.disallowedTools).toContain('Write');
    expect(provenance.get('roles.reviewer.disallowedTools')).toBe('default');
  });
});

describe('resolveConfig precedence and provenance', () => {
  function writeSettingsStore(settings: JsonObject, extra: JsonObject = {}): void {
    writeFileSync(
      path.join(tmp, 'config.json'),
      `${JSON.stringify({ settings, ...extra }, null, 2)}\n`,
    );
  }

  it('falls through to DEFAULT_CONFIG when no layer supplies a value', () => {
    const { config, provenance } = resolveConfig({ env: {}, home: tmp });
    expect(config.settings.maxIters).toBe(5);
    expect(config.settings.quality).toBe('balanced');
    expect(provenance.get('settings.iters')).toBe('default');
    expect(config.providers.claudePermissionMode).toBe('default');
    expect(provenance.get('claudePermissionMode')).toBe('default');
  });

  it('store wins over the default', () => {
    writeSettingsStore({ iters: 7 });
    const { config, provenance } = resolveConfig({ env: {}, home: tmp });
    expect(config.settings.maxIters).toBe(7);
    expect(provenance.get('settings.iters')).toBe('store');
  });

  it('env wins over the store', () => {
    writeSettingsStore({ iters: 7 });
    const { config, provenance } = resolveConfig({
      env: { AGENT_QUORUM_MAX_ITERS: '9' },
      home: tmp,
    });
    expect(config.settings.maxIters).toBe(9);
    expect(provenance.get('settings.iters')).toBe('env');
  });

  it('a CLI override wins over env (override tier)', () => {
    writeSettingsStore({ iters: 7 });
    const { config, provenance } = resolveConfig({
      overrides: { cli: { maxIters: '11' } },
      env: { AGENT_QUORUM_MAX_ITERS: '9' },
      home: tmp,
    });
    expect(config.settings.maxIters).toBe(11);
    expect(provenance.get('settings.iters')).toBe('override');
  });

  it('a structured config override wins over env (override tier)', () => {
    const { config, provenance } = resolveConfig({
      overrides: { config: { settings: { iters: 13 } } },
      env: { AGENT_QUORUM_MAX_ITERS: '9' },
      home: tmp,
    });
    expect(config.settings.maxIters).toBe(13);
    expect(provenance.get('settings.iters')).toBe('override');
  });

  it('intra-override tie-break: a top-level CLI scalar beats structured config', () => {
    const { config } = resolveConfig({
      overrides: { cli: { maxIters: '11' }, config: { settings: { iters: 13 } } },
      env: {},
      home: tmp,
    });
    expect(config.settings.maxIters).toBe(11);
  });

  it('records the winning layer for claudePermissionMode at each tier', () => {
    writeSettingsStore({}, { claudePermissionMode: 'plan' });
    const fromStore = resolveConfig({ env: {}, home: tmp });
    expect(fromStore.config.providers.claudePermissionMode).toBe('plan');
    expect(fromStore.provenance.get('claudePermissionMode')).toBe('store');

    const fromEnv = resolveConfig({ env: { CLAUDE_PERMISSION_MODE: 'acceptEdits' }, home: tmp });
    expect(fromEnv.config.providers.claudePermissionMode).toBe('acceptEdits');
    expect(fromEnv.provenance.get('claudePermissionMode')).toBe('env');

    const fromOverride = resolveConfig({
      overrides: { config: { claudePermissionMode: 'bypassPermissions' } },
      env: { CLAUDE_PERMISSION_MODE: 'acceptEdits' },
      home: tmp,
    });
    expect(fromOverride.config.providers.claudePermissionMode).toBe('bypassPermissions');
    expect(fromOverride.provenance.get('claudePermissionMode')).toBe('override');
  });

  it('resolves status max-plan-lines, retention, and provider knobs from the store', () => {
    writeFileSync(
      path.join(tmp, 'config.json'),
      `${JSON.stringify({
        status: { maxPlanLines: 1234 },
        retention: { keepCount: 7, maxAgeDays: 14 },
        providers: { cursorBin: '/opt/cursor', livenessHeartbeatSeconds: 12 },
      })}\n`,
    );
    const { config, provenance } = resolveConfig({ env: {}, home: tmp });
    expect(config.status.maxPlanLines).toBe(1234);
    expect(provenance.get('status.maxPlanLines')).toBe('store');
    expect(config.retention).toEqual({ keepCount: 7, maxAgeDays: 14 });
    expect(config.providers.cursorBin).toBe('/opt/cursor');
    expect(config.providers.livenessHeartbeatSeconds).toBe(12);

    const env = resolveConfig({ env: { AGENT_QUORUM_MAX_PLAN_LINES: '50' }, home: tmp });
    expect(env.config.status.maxPlanLines).toBe(50);
    expect(env.provenance.get('status.maxPlanLines')).toBe('env');
  });
});
