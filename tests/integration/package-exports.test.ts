import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/harness.js';

let tempDir: string;

interface ConsumerRunResult {
  status: number | null;
  stderr: string;
}

// Both consumer processes run with cwd=tempDir: `require`/`import` in a -e
// script resolve from the process cwd, and the agent-quorum symlink lives in
// tempDir/node_modules.
function runConsumer(args: string[]): ConsumerRunResult {
  const result = spawnSync(process.execPath, args, { cwd: tempDir, encoding: 'utf8' });
  return { status: result.status, stderr: result.stderr };
}

beforeAll(() => {
  const build = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', 'tsconfig.build.json'],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  );
  expect(build.status, `tsc build failed:\n${build.stdout}${build.stderr}`).toBe(0);

  tempDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-exports.'));
  mkdirSync(path.join(tempDir, 'node_modules'));
  symlinkSync(REPO_ROOT, path.join(tempDir, 'node_modules', 'agent-quorum'), 'dir');
}, 120_000);

afterAll(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe('package exports (ESM + CJS consumability)', () => {
  it('require() loads the package from CommonJS and resolves package.json', () => {
    const script =
      "const aq = require('agent-quorum');" +
      "if (typeof aq.runPlanLoop !== 'function') throw new Error('runPlanLoop missing');" +
      "if (typeof aq.launchPlanLoop !== 'function') throw new Error('launchPlanLoop missing');" +
      "if (typeof aq.getRunStatus !== 'function') throw new Error('getRunStatus missing');" +
      "const pkg = require.resolve('agent-quorum/package.json');" +
      "if (!pkg.endsWith('package.json')) throw new Error('package.json not resolved');";
    const result = runConsumer(['-e', script]);
    expect(result.status, result.stderr).toBe(0);
  });

  it('import() loads the same build from ESM', () => {
    const script =
      "const aq = await import('agent-quorum');" +
      "if (typeof aq.runPlanLoop !== 'function') throw new Error('runPlanLoop missing');" +
      "if (typeof aq.addIntervention !== 'function') throw new Error('addIntervention missing');";
    const result = runConsumer(['--input-type=module', '-e', script]);
    expect(result.status, result.stderr).toBe(0);
  });
});
