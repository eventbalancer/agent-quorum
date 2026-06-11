import { rmSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { err } from '../runtime/log.js';
import { spawnDetached, waitForExit } from '../runtime/exec.js';
import { StreamLogFilter } from './stream-log.js';
import type { ProviderRuntime } from './runtime.js';

// codex runs every role statelessly with --sandbox read-only on every call, so
// the read-only posture is provable from argv. model/reasoning are per call.
function codexArgs(
  model: string,
  reasoning: string,
  schemaPath: string,
  outPath: string,
  prompt: string,
): string[] {
  return [
    'exec',
    '--sandbox',
    'read-only',
    '--skip-git-repo-check',
    '--color',
    'never',
    '-m',
    model,
    '-c',
    `model_reasoning_effort="${reasoning}"`,
    '--output-schema',
    schemaPath,
    '-o',
    outPath,
    '--',
    prompt,
  ];
}

export async function codexRun(
  rt: ProviderRuntime,
  model: string,
  reasoning: string,
  schemaPath: string,
  outPath: string,
  prompt: string,
): Promise<number> {
  rmSync(outPath, { force: true });

  const child = spawnDetached('codex', codexArgs(model, reasoning, schemaPath, outPath, prompt), {
    cwd: rt.projectRoot,
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const filter = new StreamLogFilter();
  let pending = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    pending += chunk.toString();
    for (;;) {
      const nl = pending.indexOf('\n');
      if (nl === -1) {
        break;
      }
      for (const rendered of filter.line(pending.slice(0, nl))) {
        process.stderr.write(`${rendered}\n`);
      }
      pending = pending.slice(nl + 1);
    }
  });
  const status = await waitForExit(child);
  if (pending !== '') {
    for (const rendered of filter.line(pending)) {
      process.stderr.write(`${rendered}\n`);
    }
  }

  if (status !== 0) {
    return status;
  }
  if (!nonEmptyFile(outPath)) {
    err('codex produced empty output');
    return 4;
  }
  return 0;
}
