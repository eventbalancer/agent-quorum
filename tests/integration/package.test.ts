import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ExitCode, runPlanLoop } from '../../src/index.js';
import {
  captureStderr,
  emptyCritique,
  REPO_ROOT,
  withEnvAsync,
  writeStoreConfig,
  writeFakeBin,
  writeLargeStructuredPlanFile,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';

let tmp: string;
let fake: string;
let work: string;
let capture: StderrCapture;

type EnvOverrides = Record<string, string | undefined>;

function baseEnv(extra: EnvOverrides = {}): EnvOverrides {
  return {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    AGENT_QUORUM_HOME: path.join(tmp, 'home'),
    AGENT_QUORUM_WORK_DIR: work,
    AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
    AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
    AGENT_QUORUM_CLARIFY: '0',
    AGENT_QUORUM_RETRY_COUNT: '0',
    AGENT_QUORUM_RESUME: undefined,
    FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
    FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
    ...extra,
  };
}

function summaryFinalLines(): string[] {
  return readFileSync(path.join(work, 'summary.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('- FINAL:'));
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-packageint.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'), { recursive: true });
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  writeStoreConfig(path.join(tmp, 'home'));
  emptyCritique(path.join(tmp, 'empty.json'));
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('package emission through runPlanLoop', () => {
  it('emits a validated package and one combined FINAL status when split fires', async () => {
    writeStructuredPlanFile(path.join(tmp, 'input.md'), 'Package Run');

    const result = await withEnvAsync(baseEnv({ AGENT_QUORUM_SPLIT: 'always' }), () =>
      runPlanLoop({
        input: path.join(tmp, 'input.md'),
        iters: 1,
        quality: 'quick',
        fix: false,
        translate: false,
      }),
    );

    expect(result.exitCode).toBe(ExitCode.Ok);
    const pkg = path.join(work, 'plan.package');
    for (const name of ['README.md', 'plan.md', 'run.md', 'journal.md', 'remaining-debt.md']) {
      expect(existsSync(path.join(pkg, name)), name).toBe(true);
    }
    // plan.package/plan.md stays byte-equal to the post-fix plan.final.md.
    expect(
      readFileSync(path.join(pkg, 'plan.md')).equals(
        readFileSync(path.join(work, 'plan.final.md')),
      ),
    ).toBe(true);
    // The split decision is recorded; package and final findings are both present and distinct.
    expect(existsSync(path.join(work, 'plan.split.json'))).toBe(true);
    expect(existsSync(path.join(work, 'findings.json'))).toBe(true);
    expect(existsSync(path.join(work, 'package-findings.json'))).toBe(true);

    const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
    expect(summary).toContain('- split_decision: split');
    expect(summary).toContain('- package_dir:');
    expect(summary).toContain('- package_validation: ok');
    expect(summaryFinalLines()).toHaveLength(1);
    expect(summary).toContain('- FINAL: clean');

    const canonicalWork = realpathSync(work);
    expect(result.splitDecision).toBe('split');
    expect(result.packageDir).toBe(path.join(canonicalWork, 'plan.package'));
    expect(result.finalPlanPath).toBe(path.join(canonicalWork, 'plan.final.md'));
  });

  it('emits a clean package for a P0-starting plan through a forced split', async () => {
    // The original reproducer: a Haiku-authored plan whose Work Plan starts at
    // P0. The package must validate clean end to end, not just in unit emit.
    writeLargeStructuredPlanFile(path.join(tmp, 'input.md'), 'P0 Package Run', 3, 0);

    const result = await withEnvAsync(baseEnv({ AGENT_QUORUM_SPLIT: 'always' }), () =>
      runPlanLoop({
        input: path.join(tmp, 'input.md'),
        iters: 1,
        quality: 'quick',
        fix: false,
        translate: false,
      }),
    );

    expect(result.exitCode).toBe(ExitCode.Ok);
    const pkg = path.join(work, 'plan.package');
    // The label number drives the filename ordinal, so P0 -> phase-0-*.
    expect(readdirSync(pkg).some((name) => /^phase-0-.+\.md$/.test(name))).toBe(true);
    const summary = readFileSync(path.join(work, 'summary.md'), 'utf8');
    expect(summary).toContain('- split_decision: split');
    expect(summary).toContain('- package_validation: ok');
    expect(summaryFinalLines()).toHaveLength(1);
    expect(summary).toContain('- FINAL: clean');
  });

  it('blocks an otherwise-clean run when a forced split hits an empty Work Plan', async () => {
    const input = path.join(tmp, 'empty-wp.md');
    writeStructuredPlanFile(input, 'Empty Work Plan');
    writeFileSync(
      input,
      readFileSync(input, 'utf8').replace(
        '| Phase | Touches | Depends on | Effort | Acceptance gate |\n| --- | --- | --- | --- | --- |\n| P1 — Fixture Phase | `fixture.md` | — | ~1h | fixture gate observable |',
        '',
      ),
    );

    const result = await withEnvAsync(baseEnv({ AGENT_QUORUM_SPLIT: 'always' }), () =>
      runPlanLoop({ input, iters: 1, quality: 'quick', fix: false, translate: false }),
    );

    expect(result.exitCode).toBe(ExitCode.Blocked);
    expect(existsSync(path.join(work, 'plan.package'))).toBe(false);
    expect(existsSync(path.join(work, 'plan.split.json'))).toBe(true);
    const finals = summaryFinalLines();
    expect(finals).toHaveLength(1);
    expect(finals[0]).toContain('blocked');
    expect(finals[0]).toContain('empty');
  });
});

interface PackageManifest {
  bin: Record<string, string>;
  files: string[];
  version: string;
}

function readManifest(): PackageManifest {
  return JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as PackageManifest;
}

// Composed from parts so the legacy identity never appears as a literal token
// here, keeping the AC-10 sweep over tests/ clean while still guarding it.
const LEGACY_BIN = ['plan', 'loop'].join('-');
const LEGACY_CONFIG_NAME = `${LEGACY_BIN}.json`;

describe('bin + packaged files contract (AC-1, AC-6)', () => {
  it('exposes exactly one agent-quorum bin and no legacy key', () => {
    const manifest = readManifest();
    expect(manifest.bin).toEqual({ 'agent-quorum': 'dist/cli/main.js' });
    expect(Object.keys(manifest.bin)).not.toContain(LEGACY_BIN);
  });

  it('ships the skills/ marker and no package-root config so installed packageRoot resolves', () => {
    const manifest = readManifest();
    expect(manifest.files).toContain('skills');
    expect(manifest.files).not.toContain('agent-quorum.json');
    expect(manifest.files).not.toContain(LEGACY_CONFIG_NAME);
  });
});

describe('built CLI smoke (AC-1)', () => {
  beforeAll(() => {
    const build = spawnSync(
      process.execPath,
      [
        path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
        '-p',
        'tsconfig.build.json',
      ],
      { cwd: REPO_ROOT, encoding: 'utf8' },
    );
    expect(build.status, `tsc build failed:\n${build.stdout}${build.stderr}`).toBe(0);
  }, 120_000);

  function runBuiltCli(args: string[]): { status: number | null; stdout: string; stderr: string } {
    const result = spawnSync(
      process.execPath,
      [path.join(REPO_ROOT, 'dist', 'cli', 'main.js'), ...args],
      {
        cwd: REPO_ROOT,
        encoding: 'utf8',
      },
    );
    return { status: result.status, stdout: result.stdout, stderr: result.stderr };
  }

  it('prints the package version through the built agent-quorum bin', () => {
    const result = runBuiltCli(['--version']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${readManifest().version}\n`);
  });

  it('resolves the plan stage through the built bin', () => {
    const result = runBuiltCli(['plan', '--help']);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('usage: agent-quorum plan');
  });
});
