import { isJsonObject, jqAlt, type JsonObject, type JsonValue } from '../core/json.js';
import {
  capTraceBody,
  classifyReason,
  describeCommand,
  describeText,
  describeToolActivity,
  dim,
  red,
  TRACE_INDENT,
  traceLine,
} from './trace.js';

function jqToString(value: JsonValue | undefined): string {
  if (value === undefined || value === null) {
    return String(value);
  }
  if (typeof value === 'string') {
    return value;
  }
  return JSON.stringify(value);
}

function parseEvent(line: string): JsonObject | undefined {
  let event: JsonValue;
  try {
    event = JSON.parse(line) as JsonValue;
  } catch {
    return undefined;
  }
  return isJsonObject(event) ? event : undefined;
}

function firstPresent(event: JsonObject, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = event[key];
    if (value !== undefined && value !== null && value !== false) {
      return jqToString(value);
    }
  }
  return undefined;
}

function subObject(parent: JsonObject | undefined, key: string): JsonObject | undefined {
  if (parent === undefined) {
    return undefined;
  }
  const value = parent[key];
  return isJsonObject(value) ? value : undefined;
}

function callArgs(call: JsonObject): JsonObject {
  return isJsonObject(call.args) ? call.args : {};
}

function contentText(value: JsonValue | undefined): string {
  if (typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item);
      } else if (isJsonObject(item)) {
        const text = item.text ?? item.message;
        if (text !== undefined && text !== null) {
          parts.push(jqToString(text));
        }
      }
    }
    return parts.join(' ');
  }
  if (isJsonObject(value)) {
    const text = value.text ?? value.message;
    if (text === undefined || text === null) {
      return '';
    }
    return jqToString(text);
  }
  return '';
}

type EventRenderer = (event: JsonObject) => string[] | undefined;

function pushText(out: string[], value: JsonValue | undefined): void {
  const marker = describeText(contentText(value));
  if (marker !== undefined) {
    out.push(traceLine('text', marker));
  }
}

function assistantContent(event: JsonObject): readonly JsonValue[] {
  const message = isJsonObject(event.message) ? event.message : {};
  return Array.isArray(message.content) ? message.content : [];
}

function renderAssistantContent(
  content: readonly JsonValue[],
  shouldRenderTools: boolean,
): string[] {
  const out: string[] = [];
  for (const item of content) {
    if (!isJsonObject(item)) {
      continue;
    }
    if (shouldRenderTools && item.type === 'tool_use') {
      out.push(traceLine('tool', describeToolActivity(jqToString(item.name), item.input)));
    } else if (item.type === 'text') {
      pushText(out, item.text);
    }
  }
  return out;
}

function dispatch(line: string, renderers: readonly EventRenderer[]): string[] {
  const event = parseEvent(line);
  if (event === undefined) {
    return [];
  }
  for (const render of renderers) {
    const rendered = render(event);
    if (rendered !== undefined) {
      return rendered;
    }
  }
  return [];
}

function renderAssistantMessage(event: JsonObject): string[] | undefined {
  if (event.type !== 'assistant') {
    return undefined;
  }
  return renderAssistantContent(assistantContent(event), true);
}

function renderCodexItem(event: JsonObject): string[] | undefined {
  const item = isJsonObject(event.item) ? event.item : undefined;
  if (item === undefined) {
    return undefined;
  }

  const isCommandExec = item.type === 'command_execution';
  const isExecStart = event.type === 'item.started' && isCommandExec;
  const isExecFailure =
    event.type === 'item.completed' && isCommandExec && jqAlt(item.exit_code, 0) !== 0;
  const isItemLifecycle = event.type === 'item.started' || event.type === 'item.completed';
  const hasContent = item.content !== undefined && item.content !== null;

  if (isExecStart) {
    return [traceLine('exec', `exec ${describeCommand(jqAlt(item.command, ''))}`)];
  }
  if (isExecFailure) {
    const code = jqToString(jqAlt(item.exit_code, 0));
    return [
      traceLine('exec-failed', `exec failed(${code}) ${describeCommand(jqAlt(item.command, ''))}`),
    ];
  }
  if (isItemLifecycle && hasContent) {
    const out: string[] = [];
    pushText(out, item.content);
    return out;
  }
  return undefined;
}

function renderAgentMessage(event: JsonObject): string[] | undefined {
  const isAgentMessage =
    event.type === 'agent_message' && event.message !== undefined && event.message !== null;
  if (!isAgentMessage) {
    return undefined;
  }
  const out: string[] = [];
  pushText(out, event.message);
  return out;
}

function isRetryEvent(event: JsonObject): boolean {
  const subtype = jqToString(jqAlt(event.subtype, ''));
  return (
    event.type === 'api_retry' ||
    (event.type === 'system' && subtype.includes('retry')) ||
    (event.retry !== undefined && event.retry !== null) ||
    (event.attempt !== undefined && event.attempt !== null)
  );
}

function renderRetry(event: JsonObject): string[] | undefined {
  if (!isRetryEvent(event)) {
    return undefined;
  }
  const attempt = firstPresent(event, ['attempt', 'retry']) ?? '?';
  const max = firstPresent(event, ['max_retries', 'max_attempts', 'maxRetries']) ?? '?';
  const delay = firstPresent(event, ['delay_ms', 'delayMs', 'retry_after_ms']) ?? '?';
  const token = classifyReason(firstPresent(event, ['error', 'message', 'reason']));
  const suffix = token !== undefined ? `: ${token}` : '';
  return [traceLine('retry', `api retry ${attempt}/${max} after ${delay}ms${suffix}`)];
}

const CODEX_RENDERERS: readonly EventRenderer[] = [
  renderAssistantMessage,
  renderCodexItem,
  renderAgentMessage,
  renderRetry,
];

export function streamJsonEvent(line: string): string[] {
  return dispatch(line, CODEX_RENDERERS);
}

function streamPlainExec(text: string): string {
  return traceLine('exec', `exec ${describeCommand(text)}`);
}

export class StreamLogFilter {
  private isExec = false;
  private wantsTokens = false;
  private thinkingSeen = 0;
  private readonly thinkingEvery: number;

  constructor(thinkingEvery?: number) {
    this.thinkingEvery =
      thinkingEvery ?? Number(process.env.AGENT_QUORUM_CLAUDE_THINKING_LOG_EVERY ?? 3);
  }

  line(line: string): string[] {
    if (this.isExec) {
      this.isExec = false;
      return [streamPlainExec(line)];
    }
    if (this.wantsTokens) {
      this.wantsTokens = false;
      return [`${TRACE_INDENT}${dim(`tokens: ${line}`)}`];
    }
    if (line === 'exec') {
      this.isExec = true;
      return [];
    }
    if (line === 'tokens used') {
      this.wantsTokens = true;
      return [];
    }
    if (line.includes('"thinking_tokens"')) {
      this.thinkingSeen += 1;
      if (this.thinkingEvery > 0 && this.thinkingSeen % this.thinkingEvery === 1) {
        return [`${TRACE_INDENT}thinking... (${this.thinkingSeen} heartbeats)`];
      }
      return [];
    }
    if (line.startsWith('{')) {
      return streamJsonEvent(line);
    }
    return [];
  }
}

function renderCursorAssistant(event: JsonObject): string[] | undefined {
  if (event.type !== 'assistant') {
    return undefined;
  }
  return renderAssistantContent(assistantContent(event), false);
}

function describeCursorFunction(fn: JsonObject): string {
  const name = jqToString(jqAlt(fn.name, 'tool'));
  const argsText = jqToString(jqAlt(fn.arguments, ''));
  const trimmed = argsText.trim();
  const argc = trimmed === '' ? 0 : trimmed.split(/\s+/).length;
  return `${name} (${argc} args, ${argsText.length} chars)`;
}

function renderCursorToolStarted(event: JsonObject): string[] | undefined {
  const isToolCallStart = event.type === 'tool_call' && event.subtype === 'started';
  if (!isToolCallStart) {
    return undefined;
  }
  const toolCall = subObject(event, 'tool_call');
  const read = subObject(toolCall, 'readToolCall');
  if (read !== undefined) {
    return [traceLine('tool', describeToolActivity('Read', callArgs(read)))];
  }
  const write = subObject(toolCall, 'writeToolCall');
  if (write !== undefined) {
    return [traceLine('tool', describeToolActivity('Write', callArgs(write)))];
  }
  const functionCall = subObject(toolCall, 'function');
  if (functionCall !== undefined) {
    return [traceLine('tool', describeCursorFunction(functionCall))];
  }
  return [traceLine('tool', 'tool_call')];
}

function renderCursorToolCompleted(event: JsonObject): string[] | undefined {
  const isToolCallCompletion = event.type === 'tool_call' && event.subtype === 'completed';
  if (!isToolCallCompletion) {
    return undefined;
  }
  const write = subObject(subObject(event, 'tool_call'), 'writeToolCall');
  if (write === undefined) {
    return [];
  }
  const success = subObject(write, 'result')?.success;
  const writeSucceeded = success !== undefined && success !== null && success !== false;
  if (!writeSucceeded) {
    return [];
  }
  const target = jqToString(jqAlt(callArgs(write).path, ''));
  const body = target !== '' ? `write completed ${target}` : 'write completed';
  return [`${TRACE_INDENT}${red(capTraceBody(body))}`];
}

const CURSOR_RENDERERS: readonly EventRenderer[] = [
  renderCursorAssistant,
  renderCursorToolStarted,
  renderCursorToolCompleted,
];

export function cursorStreamJsonEvent(line: string): string[] {
  return dispatch(line, CURSOR_RENDERERS);
}

export class CursorStreamLogFilter {
  line(line: string): string[] {
    if (!line.startsWith('{')) {
      return [];
    }
    return cursorStreamJsonEvent(line);
  }
}
