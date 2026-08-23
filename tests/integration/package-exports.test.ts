import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { REPO_ROOT } from '../helpers/harness.js';

let tempDir: string;

interface ConsumerRunResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

// Both consumer processes run with cwd=tempDir: `require`/`import` in a -e
// script resolve from the process cwd, and the agent-quorum symlink lives in
// tempDir/node_modules.
function runConsumer(args: string[]): ConsumerRunResult {
  const result = spawnSync(process.execPath, args, { cwd: tempDir, encoding: 'utf8' });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
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
      "if (aq.RUN_RECORD_SCHEMA_VERSION !== 1) throw new Error('run record schema missing');" +
      "const pkg = require.resolve('agent-quorum/package.json');" +
      "if (!pkg.endsWith('package.json')) throw new Error('package.json not resolved');";
    const result = runConsumer(['-e', script]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('import() loads the same build from ESM', () => {
    const script =
      "const aq = await import('agent-quorum');" +
      "if (typeof aq.runPlanLoop !== 'function') throw new Error('runPlanLoop missing');" +
      "if (typeof aq.addIntervention !== 'function') throw new Error('addIntervention missing');";
    const result = runConsumer(['--input-type=module', '-e', script]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  it('publishes the current final projection and removes legacy convergence fields', () => {
    const consumer = path.join(tempDir, 'consumer.ts');
    writeFileSync(
      consumer,
      "import type { CompletenessPromise, FinalProjection, JudgeProofProjection, OccurrenceCoverageProjection, OccurrenceSourceProjection, ReadinessDecision, ReadinessLimit, ReadinessProofProjection, RiskDomain, RunFinalStatus, RunRecord, RunResult } from 'agent-quorum';\n" +
        '// @ts-expect-error legacy convergence types are no longer public\n' +
        "import type { ConvergenceReport } from 'agent-quorum';\n" +
        '// @ts-expect-error compatibility convergence limits are no longer public\n' +
        "import type { ConvergenceLimit } from 'agent-quorum';\n" +
        '// @ts-expect-error flat final readiness is no longer public\n' +
        "import type { FinalReadiness } from 'agent-quorum';\n" +
        'declare const final: FinalProjection;\n' +
        'const status: RunFinalStatus = final.status;\n' +
        "const promise: CompletenessPromise = 'cumulative';\n" +
        "const limit: ReadinessLimit = 'iteration-cap';\n" +
        'const decision: ReadinessDecision = final.readiness.decision;\n' +
        "const domain: RiskDomain = 'correctness';\n" +
        'const readiness: ReadinessProofProjection = final.readiness;\n' +
        'const coverage: OccurrenceCoverageProjection = readiness.occurrenceCoverage;\n' +
        'const source: OccurrenceSourceProjection | undefined = coverage.sources[0];\n' +
        'const judge: JudgeProofProjection = final.judge;\n' +
        '// @ts-expect-error final projections are readonly\n' +
        "final.status = 'clean';\n" +
        '// @ts-expect-error occurrence projections expose readonly arrays\n' +
        "coverage.reasonCodes.push('mutated');\n" +
        "const result: Pick<RunResult, 'final'> = { final };\n" +
        "const durable: Pick<RunRecord, 'schemaVersion' | 'final'> = { schemaVersion: 1, final };\n" +
        'declare const runResult: RunResult;\n' +
        '// @ts-expect-error flat final status was removed\n' +
        'runResult.status;\n' +
        'declare const record: RunRecord;\n' +
        '// @ts-expect-error durable flat convergence was removed\n' +
        'record.finalConvergence;\n' +
        'void [status, promise, limit, decision, domain, readiness, coverage, source, judge, result, durable];\n',
    );
    const result = runConsumer([
      path.join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'),
      '--noEmit',
      '--strict',
      '--skipLibCheck',
      '--target',
      'ES2022',
      '--module',
      'NodeNext',
      '--moduleResolution',
      'NodeNext',
      consumer,
    ]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });
});
