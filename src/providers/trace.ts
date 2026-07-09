import { closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import { isJsonObject, type JsonValue } from '../core/json.js';
import { colorsEnabled, err, log } from '../runtime/log.js';
import type { Role, Runner } from '../types.js';

// Redaction contract: every rendered line is metadata only — activity kind,
// tool name, target path, command/size descriptor, classified reason. It never
// carries prompt, plan, source, tool-argument values, prose, raw command
// bodies, or free-text provider reasons.

export interface TraceContext {
  readonly role: Role;
  readonly provider: Runner;
  readonly model: string;
}

export type TraceKind = 'tool' | 'text' | 'exec' | 'exec-failed' | 'thinking' | 'retry';

// Applied at render time, not import, so TTY/NO_COLOR changes after load gate output.
function paint(code: string, text: string): string {
  return colorsEnabled() ? `${code}${text}\x1b[0m` : text;
}
const yellow = (text: string): string => paint('\x1b[33m', text);
export const red = (text: string): string => paint('\x1b[31m', text);
export const dim = (text: string): string => paint('\x1b[2m', text);

// 4-space indent keeps these lines below status's `[agent-quorum]` filter so the
// per-event trace never reaches phaseActiveRole / last-event parsing.
export const TRACE_INDENT = '    ';
const TRACE_LINE_CAP = 200;

const KIND_COLOR: Record<TraceKind, (text: string) => string> = {
  tool: yellow,
  exec: yellow,
  'exec-failed': red,
  text: dim,
  thinking: dim,
  retry: (text: string): string => text,
};

export function capTraceBody(body: string): string {
  return body.length > TRACE_LINE_CAP ? body.slice(0, TRACE_LINE_CAP) : body;
}

export function traceLine(kind: TraceKind, body: string): string {
  return `${TRACE_INDENT}${KIND_COLOR[kind](capTraceBody(body))}`;
}

const TARGET_KEYS = ['path', 'file_path', 'filePath', 'file', 'target_file', 'notebook_path'];

function extractTargetPath(input: JsonValue | undefined): string | undefined {
  if (!isJsonObject(input)) {
    return undefined;
  }
  for (const key of TARGET_KEYS) {
    const value = input[key];
    if (typeof value === 'string' && value !== '') {
      return value;
    }
  }
  return undefined;
}

export function describeToolActivity(name: string, input: JsonValue | undefined): string {
  const target = extractTargetPath(input);
  if (target !== undefined) {
    return `${name} ${target}`;
  }
  if (isJsonObject(input)) {
    const keys = Object.keys(input);
    const chars = JSON.stringify(input).length;
    const keyPart = keys.length > 0 ? `[${keys.join(', ')}] ` : '';
    return `${name} ${keyPart}(${keys.length} keys, ${chars} chars)`;
  }
  if (input === undefined || input === null) {
    return name;
  }
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  return `${name} (${text.length} chars)`;
}

export function describeText(prose: string): string | undefined {
  if (prose === '') {
    return undefined;
  }
  return `text (${prose.length} chars)`;
}

const ZSH_LC_PREFIX = '-lc "';
const ZSH_LC_SUFFIX = '" in ';

function unwrapInnerCommand(raw: string): string {
  const quoted = /-lc "(.*)"/s.exec(raw);
  if (quoted) {
    return quoted[1] ?? '';
  }
  const start = raw.indexOf(ZSH_LC_PREFIX);
  if (start === -1) {
    return raw;
  }
  let cmd = raw.slice(start + ZSH_LC_PREFIX.length);
  const tail = cmd.indexOf(ZSH_LC_SUFFIX);
  if (tail !== -1) {
    cmd = cmd.slice(0, tail);
  }
  return cmd;
}

function commandText(command: JsonValue | undefined): string {
  if (typeof command === 'string') {
    return command;
  }
  if (command === undefined || command === null) {
    return '';
  }
  return JSON.stringify(command);
}

export function describeCommand(command: JsonValue | undefined): string {
  const text = commandText(command);
  const inner = unwrapInnerCommand(text);
  const trimmed = inner.trim();
  const tokens = trimmed === '' ? [] : trimmed.split(/\s+/);
  const program = tokens[0] ?? '';
  const argc = Math.max(0, tokens.length - 1);
  return `${program} (${argc} args, ${inner.length} chars)`;
}

export type ProviderFailureReason =
  | 'schema-incompatible'
  | 'overloaded'
  | 'rate-limited'
  | 'authentication'
  | 'connection-closed'
  | 'quota';

// Secret-free signatures: a match maps to a short token, anything else is
// omitted so no free provider text reaches the logs.
const REASON_SIGNATURES: readonly (readonly [RegExp, ProviderFailureReason])[] = [
  [/--json-schema\s+is\s+not\s+a\s+valid\s+json\s+schema\b/, 'schema-incompatible'],
  [/overload/, 'overloaded'],
  [/rate.?limit|\b429\b|too many requests/, 'rate-limited'],
  [
    /\bunauthor|forbidden|\b401\b|\b403\b|invalid api key|api key|credential|authenticat/,
    'authentication',
  ],
  [
    /econnreset|connection (closed|reset)|socket hang ?up|\bepipe\b|disconnect/,
    'connection-closed',
  ],
  [/quota|insufficient (funds|quota|balance)|billing|payment required/, 'quota'],
];

export function classifyReason(raw: string | undefined): ProviderFailureReason | undefined {
  if (raw === undefined || raw === '') {
    return undefined;
  }
  const text = raw.toLowerCase();
  for (const [pattern, token] of REASON_SIGNATURES) {
    if (pattern.test(text)) {
      return token;
    }
  }
  return undefined;
}

export interface DiagnosticSink {
  write(chunk: Buffer | string): void;
  close(): void;
}

const STDERR_PENDING_BUDGET = 8 * 1024;
const STDERR_RING = 20;

export class ProviderStderr {
  private pending = '';
  private lineCount = 0;
  private readonly ring: string[] = [];

  constructor(
    private readonly traceContext: TraceContext,
    private readonly diagnosticSink?: DiagnosticSink,
  ) {}

  // Always consume the chunk so a piped child never blocks on a full buffer.
  push(chunk: Buffer | string): void {
    if (this.diagnosticSink !== undefined) {
      this.diagnosticSink.write(chunk);
    }
    this.pending += typeof chunk === 'string' ? chunk : chunk.toString();
    for (;;) {
      const newlineIndex = this.pending.indexOf('\n');
      if (newlineIndex === -1) {
        // Over budget with no newline: keep the prefix, drop overflow, so one
        // huge line stays one line.
        if (this.pending.length > STDERR_PENDING_BUDGET) {
          this.pending = this.pending.slice(0, STDERR_PENDING_BUDGET);
        }
        break;
      }
      this.recordLine(this.pending.slice(0, newlineIndex));
      this.pending = this.pending.slice(newlineIndex + 1);
    }
  }

  private recordLine(line: string): void {
    this.lineCount += 1;
    this.ring.push(capTraceBody(line));
    if (this.ring.length > STDERR_RING) {
      this.ring.shift();
    }
  }

  failureSummary(status: number): ProviderFailureReason | undefined {
    if (this.pending !== '') {
      this.recordLine(this.pending);
      this.pending = '';
    }
    if (status === 0) {
      return undefined;
    }
    const base = `${this.traceContext.role}/${this.traceContext.provider} call failed (status=${status}, stderr_lines=${this.lineCount})`;
    const reason = classifyReason(this.ring.join('\n'));
    err(reason !== undefined ? `${base}: ${reason}` : base);
    return reason;
  }
}

export function drainStderr(stream: Readable | null, capture: ProviderStderr): Promise<void> {
  return new Promise<void>((resolve) => {
    if (stream === null) {
      resolve();
      return;
    }
    stream.on('data', (chunk: Buffer) => {
      capture.push(chunk);
    });
    stream.once('end', () => {
      resolve();
    });
    stream.once('close', () => {
      resolve();
    });
    stream.once('error', () => {
      resolve();
    });
  });
}

// Provider calls are serial within a run, so a process-global monotonic counter
// alone makes per-call artifact names unique across retries, iterations, and the
// fix/translate passes.
let diagnosticSeq = 0;

function nextDiagnosticSeq(): number {
  diagnosticSeq += 1;
  return diagnosticSeq;
}

function messageFromUnknown(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Opt-in raw-capture sink for one provider call: lazily opens a per-call file on
// first write, streams raw stdout/stderr chunk-wise to it, and is best-effort —
// any filesystem error disables it for the rest of the call after one bounded
// warning, never failing or altering the provider call.
export function createDiagnosticSink(dir: string, ctx: TraceContext): DiagnosticSink {
  const seq = nextDiagnosticSeq();
  let fd: number | undefined;
  let opened = false;
  let disabled = false;

  const disable = (message: string): void => {
    if (disabled) {
      return;
    }
    disabled = true;
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* already gone */
      }
      fd = undefined;
    }
    err(`${ctx.role}/${ctx.provider} diagnostics unavailable: ${message.slice(0, 200)}`);
  };

  const open = (): void => {
    opened = true;
    try {
      mkdirSync(dir, { recursive: true });
      const base = `${String(seq).padStart(4, '0')}-${ctx.role}-${ctx.provider}`;
      let target = join(dir, `${base}.log`);
      for (let n = 1; existsSync(target); n += 1) {
        target = join(dir, `${base}-${n}.log`);
      }
      fd = openSync(target, 'a');
      log(`${ctx.role}/${ctx.provider} diagnostics → ${target}`);
    } catch (error) {
      disable(messageFromUnknown(error));
    }
  };

  return {
    write(chunk: Buffer | string): void {
      if (disabled) {
        return;
      }
      if (!opened) {
        open();
      }
      if (fd === undefined) {
        return;
      }
      try {
        writeSync(fd, typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
      } catch (error) {
        disable(messageFromUnknown(error));
      }
    },
    close(): void {
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {
          /* already gone */
        }
        fd = undefined;
      }
    },
  };
}
