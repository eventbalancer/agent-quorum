import { existsSync, readFileSync } from 'node:fs';
import { err } from '../runtime/log.js';
import { spawnDetached, waitForExit } from '../runtime/exec.js';
import { isJsonObject, type JsonValue } from '../core/json.js';
import { drainStderr, ProviderStderr, type DiagnosticSink, type TraceContext } from './trace.js';
import { livenessHeartbeatSeconds, runLivenessHeartbeat } from './heartbeat.js';
import { StreamState, watchStream, type StreamKnobs } from './watchdog.js';

export interface StreamRunResult {
  readonly status: number;
  readonly stallReason: string | undefined;
  readonly streamLines: string[];
}

export interface StreamRunOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly promptText: string;
  readonly cwd: string;
  readonly knobs: StreamKnobs;
  readonly renderLine: (line: string) => string[];
  readonly progressEvent: (line: string) => boolean;
  readonly traceContext: TraceContext;
  readonly diagnosticSink?: DiagnosticSink;
  readonly liveness?: boolean;
}

export async function runStreamingCli(options: StreamRunOptions): Promise<StreamRunResult> {
  const heartbeatSeconds = options.liveness === true ? livenessHeartbeatSeconds() : 0;
  const child = spawnDetached(options.command, [...options.args], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const state = new StreamState();
  const lines: string[] = [];
  let pending = '';

  function consumeLine(line: string): void {
    lines.push(line);
    if (options.progressEvent(line)) {
      state.progress += 1;
    }
    for (const rendered of options.renderLine(line)) {
      process.stderr.write(`${rendered}\n`);
    }
  }

  child.stdout?.on('data', (chunk: Buffer) => {
    if (options.diagnosticSink !== undefined) {
      options.diagnosticSink.write(chunk);
    }
    state.bytes += chunk.length;
    pending += chunk.toString();
    for (;;) {
      const newlineIndex = pending.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }
      consumeLine(pending.slice(0, newlineIndex));
      pending = pending.slice(newlineIndex + 1);
    }
  });

  const stderr = new ProviderStderr(options.traceContext, options.diagnosticSink);
  const stderrDrained = drainStderr(child.stderr, stderr);

  child.stdin?.on('error', () => {
    /* CLI exited before reading the prompt */
  });
  child.stdin?.write(options.promptText);
  child.stdin?.end();

  const stallPromise = watchStream(child, state, options.knobs);
  const heartbeat = runLivenessHeartbeat(child, options.traceContext, heartbeatSeconds);
  const status = await waitForExit(child);
  const stallReason = await stallPromise;
  await heartbeat;
  if (pending !== '') {
    consumeLine(pending);
  }
  await stderrDrained;
  stderr.failureSummary(status);

  return { status, stallReason, streamLines: lines };
}

function jqRawRender(value: JsonValue): string {
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value, null, 2);
}

export function extractResultField(streamLines: readonly string[], field: string): string {
  let out = '';
  for (const line of streamLines) {
    let event: JsonValue;
    try {
      event = JSON.parse(line) as JsonValue;
    } catch {
      continue;
    }
    if (!isJsonObject(event) || event.type !== 'result') {
      continue;
    }
    const value = event[field];
    if (value === undefined || value === null || value === false) {
      continue;
    }
    out += `${jqRawRender(value)}\n`;
  }
  return out;
}

export interface JsonExtractionContext {
  readonly existsFile: (path: string) => boolean;
  readonly readFile: (path: string) => string;
}

export const defaultJsonExtractionContext: JsonExtractionContext = {
  existsFile: (filePath) => existsSync(filePath),
  readFile: (filePath) => readFileSync(filePath, 'utf8'),
};

function parsesAsTruthyJson(text: string): boolean {
  try {
    const value = JSON.parse(text) as JsonValue;
    return value !== null && value !== false;
  } catch {
    return false;
  }
}

export interface ExtractedJson {
  readonly content: string;
  readonly fromFile?: string;
}

export function extractJsonPayload(
  rawInput: string,
  jsonContext: JsonExtractionContext,
): ExtractedJson {
  let raw = rawInput.replace(/\n+$/, '');

  try {
    const envelope = JSON.parse(raw) as JsonValue;
    if (isJsonObject(envelope)) {
      const inner = envelope.result;
      if (inner !== undefined && inner !== null && inner !== false) {
        raw = jqRawRender(inner).replace(/\n+$/, '');
      }
    }
  } catch {
    /* not an envelope */
  }

  if (raw.startsWith('```json')) {
    raw = raw.slice('```json'.length);
  }
  if (raw.startsWith('```')) {
    raw = raw.slice('```'.length);
  }
  if (raw.endsWith('```')) {
    raw = raw.slice(0, -'```'.length);
  }

  if (parsesAsTruthyJson(raw)) {
    return { content: raw };
  }

  const fenceLines = raw.split('\n');
  const firstBrace = fenceLines.findIndex((line) => line.startsWith('{'));
  raw = firstBrace === -1 ? '' : fenceLines.slice(firstBrace).join('\n').replace(/\n+$/, '');

  if (parsesAsTruthyJson(raw)) {
    return { content: raw };
  }

  const refMatch = /(\/tmp|\/var)[a-zA-Z0-9_./-]+\.json/.exec(raw);
  const refPath = refMatch?.[0];
  if (refPath !== undefined && jsonContext.existsFile(refPath)) {
    try {
      const fileContent = jsonContext.readFile(refPath);
      if (parsesAsTruthyJson(fileContent)) {
        err(
          `WARNING: model wrote JSON to ${refPath} instead of returning inline — using file content`,
        );
        return { content: fileContent, fromFile: refPath };
      }
    } catch {
      /* unreadable reference */
    }
  }

  return { content: raw };
}
