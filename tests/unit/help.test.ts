import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  globalHelp,
  INTERVENE_USAGE,
  LAUNCH_USAGE,
  packageVersion,
  STATUS_USAGE,
} from '../../src/cli/help.js';
import { RUN_USAGE } from '../../src/stages/plan/run.js';
import { REPO_ROOT, withEnv } from '../helpers/harness.js';

const STAGE_SUMMARIES = [
  { name: 'plan', summary: 'iterate plan → critique → update over a prompt or plan file' },
];

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-helptest.'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('help text', () => {
  it('usage strings name the agent-quorum bin and never the reference scripts', () => {
    for (const usage of [RUN_USAGE, LAUNCH_USAGE, INTERVENE_USAGE, STATUS_USAGE]) {
      expect(usage).toContain('agent-quorum');
      expect(usage).not.toContain('.sh');
    }
  });

  it('packageVersion reads the packaged package.json', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    expect(packageVersion()).toBe(pkg.version);
  });

  it('globalHelp advertises the interactive shell entry surface', () => {
    expect(globalHelp(STAGE_SUMMARIES)).toContain(
      'in a TTY, run agent-quorum with no command to open the interactive shell.',
    );
  });

  it('globalHelp embeds defaults from a readable config', () => {
    const config = path.join(tmp, 'agent-quorum.json');
    writeFileSync(
      config,
      JSON.stringify({ settings: { iters: 9, effort: 'max', fix: false, translate: true } }),
    );
    const help = withEnv({ AGENT_QUORUM_CONFIG_FILE: config }, () => globalHelp(STAGE_SUMMARIES));
    expect(help).toContain('usage: agent-quorum');
    expect(help).toContain('defaults: iters=9 effort=max fix=off translate=on');
    expect(help).toContain(`(from ${config})`);
  });

  it('globalHelp omits the defaults line for unreadable or shape-broken configs', () => {
    const broken = path.join(tmp, 'broken.json');
    writeFileSync(broken, '{not json');
    const withoutDefaults = withEnv({ AGENT_QUORUM_CONFIG_FILE: broken }, () =>
      globalHelp(STAGE_SUMMARIES),
    );
    expect(withoutDefaults).not.toContain('defaults:');
    expect(withoutDefaults).toContain('usage: agent-quorum');

    const noSettings = path.join(tmp, 'no-settings.json');
    writeFileSync(noSettings, '{}');
    const stillNoDefaults = withEnv({ AGENT_QUORUM_CONFIG_FILE: noSettings }, () =>
      globalHelp(STAGE_SUMMARIES),
    );
    expect(stillNoDefaults).not.toContain('defaults:');
  });
});
