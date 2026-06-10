import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

function tryRealpath(p: string): string | null {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
}
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/cli.js';
import {
  emptyCritique,
  writeDefaultPlanLoopConfig,
  writeFakeBin,
  writeStructuredPlanFile,
} from '../helpers/harness.js';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-nojq.'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

// AC-9: the port has no jq/ajv/rg prerequisites — a full run completes with a
// PATH that carries only the fake provider CLIs plus the base system dirs.
describe('no jq/ajv/rg prerequisites (AC-9)', () => {
  it('completes a clean run on a PATH without jq, ajv, or rg', () => {
    const fake = path.join(tmp, 'bin');
    writeFakeBin(fake);
    rmSync(path.join(fake, 'ajv'));
    rmSync(path.join(fake, 'pnpm'));
    const work = path.join(tmp, 'work');
    mkdirSync(work);
    writeDefaultPlanLoopConfig(path.join(tmp, 'plan-loop.json'));
    writeStructuredPlanFile(path.join(tmp, 'input.md'), 'No-JQ Input');
    emptyCritique(path.join(tmp, 'empty.json'));

    const nodeDir = path.dirname(process.execPath);
    // tsx's launcher script needs a few coreutils that live in /usr/bin, where
    // jq also lives on modern macOS — allowlist them via symlinks instead of
    // exposing the whole directory.
    const helperBin = path.join(tmp, 'helper-bin');
    mkdirSync(helperBin);
    for (const tool of ['bash', 'cp', 'cat', 'sed', 'dirname', 'uname', 'basename', 'tr', 'awk']) {
      if (existsSync(path.join('/usr/bin', tool))) {
        symlinkSync(path.join('/usr/bin', tool), path.join(helperBin, tool));
      }
    }
    // On Ubuntu /bin is a symlink to /usr/bin, which exposes jq/rg/etc.
    // Detect this and exclude /bin from the restricted PATH in that case,
    // symlinking only /bin/sh so launcher scripts can still run.
    const binReal = tryRealpath('/bin') ?? '/bin';
    const isBinUsrBin = binReal === '/usr/bin';
    if (isBinUsrBin) {
      const shReal = tryRealpath('/bin/sh');
      if (shReal !== null && !existsSync(path.join(helperBin, 'sh'))) {
        symlinkSync(shReal, path.join(helperBin, 'sh'));
      }
    }
    const restrictedPath = [fake, nodeDir, helperBin, ...(isBinUsrBin ? [] : ['/bin'])].join(':');

    for (const binary of ['jq', 'ajv', 'rg']) {
      const probe = spawnSync('/usr/bin/which', [binary], {
        encoding: 'utf8',
        env: { PATH: restrictedPath },
      });
      expect(probe.status, `${binary} must be absent from the restricted PATH`).not.toBe(0);
    }

    const result = runCli(
      ['--effort', 'low', '--iters', '1', path.join(tmp, 'input.md'), '--no-fix', '--no-translate'],
      {
        PATH: restrictedPath,
        PLAN_LOOP_CONFIG_FILE: path.join(tmp, 'plan-loop.json'),
        PLAN_LOOP_WORK_DIR: work,
        PLAN_LOOP_PLANS_DIR: path.join(tmp, 'plans'),
        PLAN_LOOP_STATE_DIR: path.join(tmp, 'state'),
        PLAN_LOOP_CLARIFY: '0',
        PLAN_LOOP_RETRY_COUNT: '0',
        FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
    );

    expect(result.stderr).toContain('done. summary:');
    expect(result.status).toBe(0);
    expect(existsSync(path.join(work, 'plan.final.md'))).toBe(true);
  });
});
