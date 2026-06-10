import { err } from '../runtime/log.js';
import { spawnDetached, waitForExit } from '../runtime/exec.js';
import { isJsonObject, type JsonValue } from '../core/json.js';
import { StreamState, watchStream, type StreamKnobs } from './watchdog.js';

export interface StreamRunResult {
  status: number;
  stallReason: string | undefined;
  streamLines: string[];
}

export interface StreamRunOptions {
  command: string;
  args: readonly string[];
  promptText: string;
  cwd: string;
  knobs: StreamKnobs;
  renderLine: (line: string) => string[];
  progressEvent: (line: string) => boolean;
}

// Equivalent of the reference's stream_claude_once / stream_cursor_once
// pipeline: spawn the CLI in its own group, mirror the NDJSON stream through
// the log filter to stderr, and let the watchdog guard byte/semantic/wall
// progress over in-memory counters instead of a tee'd temp file.
export async function runStreamingCli(options: StreamRunOptions): Promise<StreamRunResult> {
  const child = spawnDetached(options.command, [...options.args], {
    cwd: options.cwd,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const state = new StreamState();
  const lines: string[] = [];
  let pending = '';

  const consumeLine = (line: string) => {
    lines.push(line);
    if (options.progressEvent(line)) state.progress += 1;
    for (const rendered of options.renderLine(line)) {
      process.stderr.write(`${rendered}\n`);
    }
  };

  child.stdout?.on('data', (chunk: Buffer) => {
    state.bytes += chunk.length;
    pending += chunk.toString();
    for (;;) {
      const nl = pending.indexOf('\n');
      if (nl === -1) break;
      consumeLine(pending.slice(0, nl));
      pending = pending.slice(nl + 1);
    }
  });

  child.stdin?.on('error', () => {
    /* CLI exited before reading the prompt */
  });
  child.stdin?.write(options.promptText);
  child.stdin?.end();

  const stallPromise = watchStream(child, state, options.knobs);
  const status = await waitForExit(child);
  const stallReason = await stallPromise;
  if (pending !== '') consumeLine(pending);

  return { status, stallReason, streamLines: lines };
}

function jqRawRender(value: JsonValue): string {
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

// jq -r 'select(.type == "result") | .result // empty' over the stream: every
// matching event contributes its rendering plus a newline.
export function extractResultField(streamLines: readonly string[], field: string): string {
  let out = '';
  for (const line of streamLines) {
    let event: JsonValue;
    try {
      event = JSON.parse(line) as JsonValue;
    } catch {
      continue;
    }
    if (!isJsonObject(event) || event.type !== 'result') continue;
    const value = event[field];
    if (value === undefined || value === null || value === false) continue;
    out += `${jqRawRender(value)}\n`;
  }
  return out;
}

export interface JsonExtractionContext {
  existsFile: (path: string) => boolean;
  readFile: (path: string) => string;
}

function parsesAsTruthyJson(text: string): boolean {
  try {
    const value = JSON.parse(text) as JsonValue;
    return value !== null && value !== false;
  } catch {
    return false;
  }
}

export interface ExtractedJson {
  content: string;
  fromFile?: string;
}

// The shared claude/cursor JSON-result extraction chain: unwrap a {result}
// envelope, strip markdown fences, drop prose before the first `{` line, and
// finally fall back to a referenced temp-file path.
export function extractJsonPayload(rawInput: string, ctx: JsonExtractionContext): ExtractedJson {
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

  if (raw.startsWith('```json')) raw = raw.slice('```json'.length);
  if (raw.startsWith('```')) raw = raw.slice('```'.length);
  if (raw.endsWith('```')) raw = raw.slice(0, -'```'.length);

  if (parsesAsTruthyJson(raw)) return { content: raw };

  const fenceLines = raw.split('\n');
  const firstBrace = fenceLines.findIndex((line) => line.startsWith('{'));
  raw = firstBrace === -1 ? '' : fenceLines.slice(firstBrace).join('\n').replace(/\n+$/, '');

  if (parsesAsTruthyJson(raw)) return { content: raw };

  const refMatch = /(\/tmp|\/var)[a-zA-Z0-9_./-]+\.json/.exec(raw);
  const refPath = refMatch?.[0];
  if (refPath !== undefined && ctx.existsFile(refPath)) {
    try {
      const fileContent = ctx.readFile(refPath);
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
