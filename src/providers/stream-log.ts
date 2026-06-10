import { isJsonObject, jqAlt, type JsonValue } from '../core/json.js';

const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

function jqToString(value: JsonValue | undefined): string {
  if (value === undefined || value === null) return String(value);
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

function firstLine(value: JsonValue | undefined): string {
  const text = jqToString(value);
  return (text.split('\n')[0] ?? '').slice(0, 120);
}

function shortCommand(command: JsonValue | undefined): string {
  const text = jqToString(command);
  const captured = /-lc "(.*)"/.exec(text);
  return firstLine(captured ? (captured[1] ?? '') : text);
}

function contentText(value: JsonValue | undefined): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const item of value) {
      if (typeof item === 'string') parts.push(item);
      else if (isJsonObject(item)) {
        const text = item.text ?? item.message;
        if (text !== undefined && text !== null) parts.push(jqToString(text));
      }
    }
    return parts.join(' ');
  }
  if (isJsonObject(value)) {
    const text = value.text ?? value.message;
    if (text === undefined || text === null) return '';
    return jqToString(text);
  }
  return '';
}

// Port of the claude/codex stream_json_event jq program: one rendered line per
// matching content item.
export function streamJsonEvent(line: string): string[] {
  let event: JsonValue;
  try {
    event = JSON.parse(line) as JsonValue;
  } catch {
    return [];
  }
  if (!isJsonObject(event)) return [];
  const out: string[] = [];

  if (event.type === 'assistant') {
    const message = isJsonObject(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (!isJsonObject(item)) continue;
      if (item.type === 'tool_use') {
        out.push(
          `    ${YELLOW}${jqToString(item.name)}${RESET} ${jqToString(item.input).slice(0, 120)}`,
        );
      } else if (item.type === 'text') {
        out.push(`    ${DIM}${firstLine(item.text)}${RESET}`);
      }
    }
    return out;
  }

  const item = isJsonObject(event.item) ? event.item : undefined;
  if (event.type === 'item.started' && item?.type === 'command_execution') {
    out.push(`    ${YELLOW}exec${RESET} ${shortCommand(jqAlt(item.command, ''))}`);
    return out;
  }
  if (
    event.type === 'item.completed' &&
    item?.type === 'command_execution' &&
    jqAlt(item.exit_code, 0) !== 0
  ) {
    out.push(
      `    ${RED}exec failed(${jqToString(jqAlt(item.exit_code, 0))})${RESET} ${shortCommand(jqAlt(item.command, ''))}`,
    );
    return out;
  }
  const itemContent = item?.content;
  if (
    (event.type === 'item.completed' || event.type === 'item.started') &&
    itemContent !== undefined &&
    itemContent !== null
  ) {
    const text = firstLine(contentText(itemContent));
    if (text !== '') out.push(`    ${DIM}${text}${RESET}`);
    return out;
  }
  if (event.type === 'agent_message' && event.message !== undefined && event.message !== null) {
    const text = firstLine(event.message);
    if (text !== '') out.push(`    ${DIM}${text}${RESET}`);
    return out;
  }

  const subtype = jqToString(jqAlt(event.subtype, ''));
  const isRetry =
    event.type === 'api_retry' ||
    (event.type === 'system' && subtype.includes('retry')) ||
    (event.retry !== undefined && event.retry !== null) ||
    (event.attempt !== undefined && event.attempt !== null);
  if (isRetry) {
    const attempt = jqToString(jqAlt(jqAlt(event.attempt, event.retry ?? null), '?'));
    const max = jqToString(
      jqAlt(
        jqAlt(jqAlt(event.max_retries, event.max_attempts ?? null), event.maxRetries ?? null),
        '?',
      ),
    );
    const delay = jqToString(
      jqAlt(jqAlt(jqAlt(event.delay_ms, event.delayMs ?? null), event.retry_after_ms ?? null), '?'),
    );
    const reason = jqToString(
      jqAlt(jqAlt(jqAlt(event.error, event.message ?? null), event.reason ?? null), 'unknown'),
    ).slice(0, 80);
    out.push(`    claude api retry ${attempt}/${max} after ${delay}ms: ${reason}`);
  }
  return out;
}

function streamPlainExec(text: string): string {
  let cmd = text;
  const lc = cmd.indexOf('-lc "');
  if (lc !== -1) cmd = cmd.slice(lc + '-lc "'.length);
  const tail = cmd.indexOf('" in ');
  if (tail !== -1) cmd = cmd.slice(0, tail);
  return `    ${YELLOW}exec${RESET} ${cmd.slice(0, 120)}`;
}

// Stateful line filter shared by the codex and claude stream renderers.
export class StreamLogFilter {
  private isExec = false;
  private wantsTokens = false;
  private thinkingSeen = 0;
  private readonly thinkingEvery: number;

  constructor(thinkingEvery?: number) {
    this.thinkingEvery =
      thinkingEvery ?? Number(process.env.PLAN_LOOP_CLAUDE_THINKING_LOG_EVERY ?? 25);
  }

  line(line: string): string[] {
    if (this.isExec) {
      this.isExec = false;
      return [streamPlainExec(line)];
    }
    if (this.wantsTokens) {
      this.wantsTokens = false;
      return [`    ${DIM}tokens: ${line}${RESET}`];
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
        return [`    thinking... (${this.thinkingSeen} heartbeats)`];
      }
      return [];
    }
    if (line.startsWith('{')) {
      return streamJsonEvent(line);
    }
    return [];
  }
}

// Port of the cursor_stream_json_event jq program.
export function cursorStreamJsonEvent(line: string): string[] {
  let event: JsonValue;
  try {
    event = JSON.parse(line) as JsonValue;
  } catch {
    return [];
  }
  if (!isJsonObject(event)) return [];
  const out: string[] = [];

  if (event.type === 'assistant') {
    const message = isJsonObject(event.message) ? event.message : {};
    const content = Array.isArray(message.content) ? message.content : [];
    for (const item of content) {
      if (!isJsonObject(item) || item.type !== 'text') continue;
      const text = firstLine(item.text);
      if (text !== '') out.push(`    ${DIM}${text}${RESET}`);
    }
    return out;
  }

  const toolCall = isJsonObject(event.tool_call) ? event.tool_call : undefined;
  if (event.type === 'tool_call' && event.subtype === 'started') {
    const read =
      toolCall && isJsonObject(toolCall.readToolCall) ? toolCall.readToolCall : undefined;
    const write =
      toolCall && isJsonObject(toolCall.writeToolCall) ? toolCall.writeToolCall : undefined;
    const fn = toolCall && isJsonObject(toolCall.function) ? toolCall.function : undefined;
    if (read) {
      const args = isJsonObject(read.args) ? read.args : {};
      out.push(`    ${YELLOW}Read${RESET} ${firstLine(jqAlt(args.path, ''))}`);
    } else if (write) {
      const args = isJsonObject(write.args) ? write.args : {};
      out.push(`    ${YELLOW}Write${RESET} ${firstLine(jqAlt(args.path, ''))}`);
    } else if (fn) {
      out.push(
        `    ${YELLOW}${jqToString(jqAlt(fn.name, 'tool'))}${RESET} ${firstLine(jqAlt(fn.arguments, ''))}`,
      );
    } else {
      out.push(`    ${YELLOW}tool_call${RESET}`);
    }
    return out;
  }
  if (event.type === 'tool_call' && event.subtype === 'completed') {
    const write =
      toolCall && isJsonObject(toolCall.writeToolCall) ? toolCall.writeToolCall : undefined;
    const result = write && isJsonObject(write.result) ? write.result : undefined;
    const success = result?.success;
    if (success !== undefined && success !== null && success !== false) {
      const args = write && isJsonObject(write.args) ? write.args : {};
      out.push(`    ${RED}write completed${RESET} ${firstLine(jqAlt(args.path, ''))}`);
    }
    return out;
  }
  return out;
}

export class CursorStreamLogFilter {
  line(line: string): string[] {
    if (!line.startsWith('{')) return [];
    return cursorStreamJsonEvent(line);
  }
}
