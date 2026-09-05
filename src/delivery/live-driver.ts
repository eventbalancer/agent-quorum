import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { RunPlanLoopOptions, RunResult } from '../index.js';

export async function runFrozenSmokeDriver(args: readonly string[]): Promise<number> {
  const [repositoryRoot, mode, input, quality, iterationsValue, workDir, resultFile] = args;
  if (
    repositoryRoot === undefined ||
    !path.isAbsolute(repositoryRoot) ||
    (mode !== 'prompt' && mode !== 'plan') ||
    input === undefined ||
    !path.isAbsolute(input) ||
    !['quick', 'balanced', 'thorough'].includes(quality ?? '') ||
    iterationsValue === undefined ||
    workDir === undefined ||
    !path.isAbsolute(workDir) ||
    resultFile === undefined ||
    !path.isAbsolute(resultFile)
  ) {
    throw new Error('invalid frozen smoke driver request');
  }
  const iterations = Number(iterationsValue);
  if (!Number.isSafeInteger(iterations) || iterations < 1) {
    throw new Error('invalid smoke iterations');
  }
  const imported: unknown = await import(
    pathToFileURL(path.join(repositoryRoot, 'src/index.ts')).href
  );
  if (
    typeof imported !== 'object' ||
    imported === null ||
    !('runPlanLoop' in imported) ||
    typeof imported.runPlanLoop !== 'function'
  ) {
    throw new Error('candidate public API unavailable');
  }
  const runPlanLoop = imported.runPlanLoop as (options: RunPlanLoopOptions) => Promise<RunResult>;
  const result = await runPlanLoop({
    input,
    prompt: mode === 'prompt',
    quality: quality as 'quick' | 'balanced' | 'thorough',
    iters: iterations,
    translate: false,
    workDir,
  });
  writeFileSync(
    resultFile,
    `${JSON.stringify({ schemaVersion: 1, exitCode: result.exitCode, workDir: result.workDir ?? workDir, final: result.final ?? null })}\n`,
    { flag: 'wx', mode: 0o600 },
  );
  return result.exitCode;
}

if (pathToFileURL(path.resolve(process.argv[1] ?? '')).href === import.meta.url) {
  try {
    process.exitCode = await runFrozenSmokeDriver(process.argv.slice(2));
  } catch {
    process.stderr.write('frozen smoke driver rejected candidate result\n');
    process.exitCode = 1;
  }
}
