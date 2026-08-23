import { writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { runPlanLoop } from '../../src/index.js';
import type { Quality, RunMode } from '../../src/types.js';

const [mode, input, quality, iterationsValue, workDir, resultFile] = process.argv.slice(2);

if (
  (mode !== 'prompt' && mode !== 'plan') ||
  input === undefined ||
  (quality !== 'quick' && quality !== 'balanced' && quality !== 'thorough') ||
  iterationsValue === undefined ||
  workDir === undefined ||
  resultFile === undefined
) {
  throw new TypeError(
    'usage: smoke-api-runner <prompt|plan> <input> <quality> <iterations> <work-dir> <result-file>',
  );
}

const iterations = Number(iterationsValue);
if (!Number.isSafeInteger(iterations) || iterations < 1) {
  throw new TypeError('smoke iterations must be a positive integer');
}
const selectedInput = input;
const selectedWorkDir = workDir;
const selectedResultFile = resultFile;

async function main(inputMode: RunMode, selectedQuality: Quality): Promise<void> {
  const result = await runPlanLoop({
    input: path.resolve(selectedInput),
    prompt: inputMode === 'prompt',
    quality: selectedQuality,
    iters: iterations,
    translate: false,
    workDir: path.resolve(selectedWorkDir),
  });
  writeFileSync(
    path.resolve(selectedResultFile),
    `${JSON.stringify(
      {
        schemaVersion: 1,
        exitCode: result.exitCode,
        workDir: result.workDir ?? path.resolve(selectedWorkDir),
        final: result.final ?? null,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = result.exitCode;
}

await main(mode, quality);
