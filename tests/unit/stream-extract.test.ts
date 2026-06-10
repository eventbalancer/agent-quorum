import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { extractJsonPayload, extractResultField } from '../../src/providers/stream-runner.js';
import { StreamLogFilter, streamJsonEvent } from '../../src/providers/stream-log.js';
import { captureStderr, stripAnsi } from '../helpers/harness.js';

const fsCtx = {
  existsFile: (p: string) => existsSync(p),
  readFile: (p: string) => readFileSync(p, 'utf8'),
};

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-extract.'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('extractResultField', () => {
  it('renders every result event with jq -r semantics', () => {
    const lines = [
      '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}',
      '{"type":"result","result":"final text"}',
      'not json',
      '{"type":"result","result":null}',
    ];
    expect(extractResultField(lines, 'result')).toBe('final text\n');
  });
});

describe('extractJsonPayload', () => {
  it('uses valid JSON as-is', () => {
    expect(extractJsonPayload('{"a":1}', fsCtx).content).toBe('{"a":1}');
  });

  it('unwraps a {result} envelope', () => {
    const raw = JSON.stringify({ result: '{"a":1}' });
    expect(extractJsonPayload(raw, fsCtx).content).toBe('{"a":1}');
  });

  it('strips markdown fences', () => {
    expect(extractJsonPayload('```json\n{"a":1}\n```', fsCtx).content).toBe('\n{"a":1}\n');
  });

  it('strips prose before the first JSON line', () => {
    expect(extractJsonPayload('Here is the JSON:\n{"a":1}', fsCtx).content).toBe('{"a":1}');
  });

  it('falls back to a referenced temp file', () => {
    const ref = path.join(os.tmpdir(), `plan-loop-ref-${process.pid}.json`);
    writeFileSync(ref, '{"a":1}');
    const capture = captureStderr();
    try {
      const extracted = extractJsonPayload(
        `Result:\n{"truncated": tru\nWrote the full JSON to ${ref} instead`,
        fsCtx,
      );
      expect(extracted.content).toBe('{"a":1}');
      expect(extracted.fromFile).toBe(ref);
      expect(capture.text()).toContain('model wrote JSON to');
    } finally {
      capture.restore();
      rmSync(ref, { force: true });
    }
  });

  it('returns the prose-stripped remainder when nothing parses', () => {
    expect(extractJsonPayload('no json here at all', fsCtx).content).toBe('');
  });
});

describe('stream log filters', () => {
  it('renders assistant tool_use and text events', () => {
    const rendered = streamJsonEvent(
      '{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"f":1}},{"type":"text","text":"line one\\nline two"}]}}',
    ).map(stripAnsi);
    expect(rendered).toEqual(['    Read {"f":1}', '    line one']);
  });

  it('renders the exec/tokens plain-line protocol', () => {
    const filter = new StreamLogFilter(25);
    expect(filter.line('exec')).toEqual([]);
    expect(filter.line('/bin/zsh -lc "echo hello" in /repo').map(stripAnsi)).toEqual([
      '    exec echo hello',
    ]);
    expect(filter.line('tokens used')).toEqual([]);
    expect(filter.line('1234').map(stripAnsi)).toEqual(['    tokens: 1234']);
  });

  it('summarizes thinking_tokens heartbeats every Nth event', () => {
    const filter = new StreamLogFilter(2);
    const first = filter.line('{"type":"system","subtype":"thinking_tokens","tokens":1}');
    const second = filter.line('{"type":"system","subtype":"thinking_tokens","tokens":1}');
    const third = filter.line('{"type":"system","subtype":"thinking_tokens","tokens":1}');
    expect(first).toEqual(['    thinking... (1 heartbeats)']);
    expect(second).toEqual([]);
    expect(third).toEqual(['    thinking... (3 heartbeats)']);
  });

  it('renders api retry events', () => {
    const rendered = streamJsonEvent(
      '{"type":"system","subtype":"api_retry","attempt":2,"max_retries":10,"delay_ms":1172,"error":"overloaded"}',
    );
    expect(rendered).toEqual(['    claude api retry 2/10 after 1172ms: overloaded']);
  });
});
