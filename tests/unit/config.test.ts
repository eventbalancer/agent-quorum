import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  resetConfigCache,
  resolveRoleConfig,
  resolveRolePermissions,
  resolveRunSettings,
  runnersInUse,
} from '../../src/core/config.js';
import type { JsonObject } from '../../src/core/json.js';
import { effortMatrix } from '../../src/core/effort.js';
import { HaltError } from '../../src/runtime/halt.js';
import {
  captureStderr,
  defaultPlanLoopConfig,
  writeDefaultPlanLoopConfig,
  writePlanLoopConfig,
  withEnv,
} from '../helpers/harness.js';

let tmp: string;

function configPath(name: string): string {
  return path.join(tmp, `${name}.agent-quorum.json`);
}

function writeSettingsConfig(file: string, settings: JsonObject): void {
  const config = defaultPlanLoopConfig();
  config.settings = { ...(config.settings as JsonObject), ...settings };
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-configtest.'));
  resetConfigCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('run settings resolution', () => {
  it('file .settings drives iters/effort/fix/diffThreshold', () => {
    const file = configPath('file-settings');
    writeSettingsConfig(file, { iters: 7, effort: 'low', fix: false, diffThreshold: 9 });
    const capture = captureStderr();
    try {
      const settings = resolveRunSettings({}, file);
      expect(settings.maxIters).toBe(7);
      expect(settings.effort).toBe('low');
      expect(settings.fixPass).toBe(0);
      expect(settings.diffThreshold).toBe(9);
    } finally {
      capture.restore();
    }
  });

  it('env overrides a file setting', () => {
    const file = configPath('env-over-setting');
    writeSettingsConfig(file, { iters: 7 });
    const settings = withEnv({ AGENT_QUORUM_MAX_ITERS: '11' }, () => resolveRunSettings({}, file));
    expect(settings.maxIters).toBe(11);
  });

  it('CLI overrides both env and file settings', () => {
    const file = configPath('cli-over-setting');
    writeSettingsConfig(file, { iters: 7 });
    const settings = withEnv({ AGENT_QUORUM_MAX_ITERS: '11' }, () =>
      resolveRunSettings({ maxIters: '3' }, file),
    );
    expect(settings.maxIters).toBe(3);
  });

  it('an invalid settings.fix halts with a controlled validation error', () => {
    const file = configPath('invalid-fix');
    writeSettingsConfig(file, { fix: 'maybe' });
    const capture = captureStderr();
    try {
      expect(() => resolveRunSettings({}, file)).toThrow(HaltError);
      resetConfigCache();
      expect(() => resolveRunSettings({}, file)).toThrow(
        /settings\.fix must be true or false \(got 'maybe'\)/,
      );
      expect(capture.text()).toContain('settings.fix must be true or false');
    } finally {
      capture.restore();
    }
  });

  it('an unknown setting is warned and ignored', () => {
    const file = configPath('unknown-setting');
    writeSettingsConfig(file, { iters: 1, bogus: true });
    const capture = captureStderr();
    try {
      resolveRunSettings({}, file);
      expect(capture.text()).toContain("ignoring unknown setting 'bogus'");
    } finally {
      capture.restore();
    }
  });

  it('a missing required setting halts with a controlled validation error', () => {
    const file = configPath('missing-setting');
    const config = defaultPlanLoopConfig();
    const settings = config.settings as JsonObject;
    Reflect.deleteProperty(settings, 'retryCount');
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const capture = captureStderr();
    try {
      expect(() => resolveRunSettings({}, file)).toThrow(
        /missing required field settings\.retryCount/,
      );
    } finally {
      capture.restore();
    }
  });
});

describe('role matrix resolution', () => {
  it('env runner overrides file runner without mutating the file', () => {
    const file = configPath('env-over-file');
    writePlanLoopConfig(file, 'critic:claude');
    const before = readFileSync(file, 'utf8');
    const capture = captureStderr();
    try {
      const matrix = withEnv({ AGENT_QUORUM_CRITIC_RUNNER: 'codex' }, () =>
        resolveRoleConfig(file),
      );
      expect(matrix.critic.runner).toBe('codex');
      expect(readFileSync(file, 'utf8')).toBe(before);
      const onDisk = JSON.parse(readFileSync(file, 'utf8')) as {
        roles: { critic: { runner: string } };
      };
      expect(onDisk.roles.critic.runner).toBe('claude');
    } finally {
      capture.restore();
    }
  });

  it('an env runner override preserves the explicit config model', () => {
    const file = configPath('env-runner');
    writePlanLoopConfig(file, 'critic:codex:gpt-5.5');
    const capture = captureStderr();
    try {
      const matrix = withEnv({ AGENT_QUORUM_CRITIC_RUNNER: 'claude' }, () =>
        resolveRoleConfig(file),
      );
      expect(matrix.critic.runner).toBe('claude');
      expect(matrix.critic.model).toBe('gpt-5.5');
    } finally {
      capture.restore();
    }
  });

  it('a same-layer model/reasoning pin is honored as the deliberate pairing', () => {
    const file = configPath('same-layer');
    writePlanLoopConfig(file, 'critic:codex:gpt-5.4:high');
    const capture = captureStderr();
    try {
      const matrix = resolveRoleConfig(file);
      expect(matrix.critic.model).toBe('gpt-5.4');
      expect(matrix.critic.reasoning).toBe('high');
    } finally {
      capture.restore();
    }
  });

  it('role defaults resolve from the explicit config file', () => {
    const file = configPath('file-role-defaults');
    writeDefaultPlanLoopConfig(file);
    const capture = captureStderr();
    try {
      const matrix = resolveRoleConfig(file);
      expect(matrix.critic).toEqual({ runner: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' });
      expect(matrix.creator).toEqual({
        runner: 'claude',
        model: 'claude-opus-4-8',
        reasoning: 'xhigh',
      });
      expect(matrix.fixer.runner).toBe('claude');
      expect(matrix.reviewer.runner).toBe('codex');
    } finally {
      capture.restore();
    }
  });

  it('an absent config halts instead of seeding hidden defaults', () => {
    const file = configPath('missing-config');
    const capture = captureStderr();
    try {
      expect(() => resolveRoleConfig(file)).toThrow(/agent-quorum config: file not found/);
    } finally {
      capture.restore();
    }
  });

  it('an existing config is never overwritten', () => {
    const file = configPath('no-overwrite');
    writePlanLoopConfig(file, 'critic:claude', 'reviewer:claude');
    const before = readFileSync(file, 'utf8');
    const capture = captureStderr();
    try {
      resolveRoleConfig(file);
      resolveRolePermissions(file);
      resolveRunSettings({}, file);
      expect(readFileSync(file, 'utf8')).toBe(before);
    } finally {
      capture.restore();
    }
  });

  it('an invalid runner halts with a controlled validation error', () => {
    const file = configPath('invalid-runner');
    writePlanLoopConfig(file, 'critic:gemini');
    const capture = captureStderr();
    try {
      expect(() => resolveRoleConfig(file)).toThrow(/invalid runner 'gemini'/);
    } finally {
      capture.restore();
    }
  });

  it('every role resolves runner/model/reasoning (run.meta.tsv source fields)', () => {
    const file = configPath('meta-keys');
    writeDefaultPlanLoopConfig(file);
    const capture = captureStderr();
    try {
      const matrix = resolveRoleConfig(file);
      for (const role of ['critic', 'creator', 'fixer', 'reviewer'] as const) {
        expect(matrix[role].runner).toBeTruthy();
        expect(matrix[role].model).toBeTruthy();
        expect(matrix[role].reasoning).toBeTruthy();
      }
    } finally {
      capture.restore();
    }
  });
});

describe('role permissions resolution', () => {
  it('role tool permissions resolve from agent-quorum.json (array and string forms)', () => {
    const file = configPath('role-permissions');
    const config = defaultPlanLoopConfig();
    const roles = config.roles as Record<string, JsonObject>;
    roles.creator = {
      ...roles.creator,
      createTools: ['Read', 'Grep', 'Glob', 'Bash'],
      createDisallowedTools: 'Write,Edit,NotebookEdit,Agent,Task,ToolSearch,AskUserQuestion',
      updateTools: 'Read',
      updateDisallowedTools: 'Write,Bash,Edit,NotebookEdit,Agent,Task,ToolSearch,AskUserQuestion',
    };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const capture = captureStderr();
    try {
      const permissions = resolveRolePermissions(file);
      expect(permissions.creator.createTools).toBe('Read,Grep,Glob,Bash');
      expect(permissions.creator.createDisallowedTools).toBe(
        'Write,Edit,NotebookEdit,Agent,Task,ToolSearch,AskUserQuestion',
      );
      expect(permissions.creator.updateTools).toBe('Read');
      expect(permissions.critic.tools).toBe('Read,Grep,Glob');
    } finally {
      capture.restore();
    }
  });

  it('an invalid role permission halts with a controlled validation error', () => {
    const file = configPath('invalid-role-permission');
    const config = defaultPlanLoopConfig();
    const roles = config.roles as Record<string, JsonObject>;
    roles.creator = { ...roles.creator, createTools: { bad: true } };
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const capture = captureStderr();
    try {
      expect(() => resolveRolePermissions(file)).toThrow(
        /missing required field roles\.creator\.createTools/,
      );
    } finally {
      capture.restore();
    }
  });

  it('a missing required role permission halts with a controlled validation error', () => {
    const file = configPath('missing-role-permission');
    const config = defaultPlanLoopConfig();
    const roles = config.roles as Record<string, JsonObject>;
    const reviewer = roles.reviewer;
    if (reviewer) {
      Reflect.deleteProperty(reviewer, 'disallowedTools');
    }
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    const capture = captureStderr();
    try {
      expect(() => resolveRolePermissions(file)).toThrow(
        /missing required field roles\.reviewer\.disallowedTools/,
      );
    } finally {
      capture.restore();
    }
  });
});

describe('runners in use', () => {
  it('only resolved roles contribute required runners (codex off-path equivalence)', () => {
    const file = configPath('codex-off-path');
    writePlanLoopConfig(file, 'critic:claude', 'creator:claude');
    const capture = captureStderr();
    try {
      const matrix = resolveRoleConfig(file);
      expect(runnersInUse(matrix, 0, 0)).toEqual(['claude']);
      expect(runnersInUse(matrix, 1, 0)).toEqual(['codex', 'claude']);
    } finally {
      capture.restore();
    }
  });
});

describe('effort matrix', () => {
  it('maps low/high/max and rejects anything else', () => {
    expect(effortMatrix('low')).toEqual({
      sessionMode: 1,
      creatorOneShot: 1,
      previousCritiques: 'compact',
      topology: 'compact',
    });
    expect(effortMatrix('high')).toEqual({
      sessionMode: 1,
      creatorOneShot: 0,
      previousCritiques: 'full',
      topology: 'full',
    });
    expect(effortMatrix('max')).toEqual({
      sessionMode: 0,
      creatorOneShot: 0,
      previousCritiques: 'full',
      topology: 'full',
    });
    expect(() => effortMatrix('medium')).toThrow('--effort expects low, high, or max');
  });
});
