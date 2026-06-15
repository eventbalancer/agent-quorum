import { rmSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { err } from '../runtime/log.js';
import { spawnDetached, waitForExit } from '../runtime/exec.js';
import { StreamLogFilter } from './stream-log.js';
import { livenessHeartbeatSeconds, runLivenessHeartbeat } from './heartbeat.js';
import { drainStderr, ProviderStderr, type DiagnosticSink, type TraceContext } from './trace.js';
import type { ProviderRuntime } from './runtime.js';

function writeFilterLines(filter: StreamLogFilter, line: string): void {
  for (const rendered of filter.line(line)) {
    process.stderr.write(`${rendered}\n`);
  }
}

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
  providerRuntime: ProviderRuntime,
  model: string,
  reasoning: string,
  schemaPath: string,
  outPath: string,
  prompt: string,
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<number> {
  const heartbeatSeconds = livenessHeartbeatSeconds();
  rmSync(outPath, { force: true });

  const child = spawnDetached('codex', codexArgs(model, reasoning, schemaPath, outPath, prompt), {
    cwd: providerRuntime.projectRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const filter = new StreamLogFilter();
  let pending = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    if (diagnosticSink !== undefined) {
      diagnosticSink.write(chunk);
    }
    pending += chunk.toString();
    for (;;) {
      const newlineIndex = pending.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      writeFilterLines(filter, pending.slice(0, newlineIndex));
      pending = pending.slice(newlineIndex + 1);
    }
  });

  const heartbeat =
    heartbeatSeconds > 0
      ? runLivenessHeartbeat(child, traceContext, heartbeatSeconds)
      : Promise.resolve();

  // Always drain so the child never blocks on a full stderr buffer.
  const stderr = new ProviderStderr(traceContext, diagnosticSink);
  const stderrDrained = drainStderr(child.stderr, stderr);

  const status = await waitForExit(child);
  await heartbeat;
  if (pending !== '') {
    writeFilterLines(filter, pending);
  }
  await stderrDrained;
  stderr.failureSummary(status);

  if (status !== 0) {
    return status;
  }
  if (!nonEmptyFile(outPath)) {
    err('codex produced empty output');
    return 4;
  }
  return 0;
}
