import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cursorStreamJsonEvent,
  streamJsonEvent,
  StreamLogFilter,
} from '../../src/providers/stream-log.js';
import {
  sanitizeCritiqueJson,
  sanitizeUpdateMetaJson,
  combineUpdateJson,
} from '../../src/core/schema.js';
import {
  markOperatorInterventionsMigrated,
  operatorInterventionsContext,
  operatorInterventionsState,
} from '../../src/stages/plan/interventions.js';
import {
  compactCritiqueFile,
  criticPrompt,
  topologyContext,
} from '../../src/stages/plan/critic.js';
import { resolveConfig } from '../../src/core/config.js';
import { resolveWatchdogKnobs } from '../../src/core/knobs.js';
import { HaltError } from '../../src/runtime/halt.js';
import { interruptThenTerminate, spawnDetached, waitForExit } from '../../src/runtime/exec.js';
import {
  captureStderr,
  defaultPlanLoopConfig,
  stripAnsi,
  writeCritique,
} from '../helpers/harness.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import { Scratch } from '../../src/runtime/scratch.js';
import type { JsonObject } from '../../src/core/json.js';

let tmp: string;

interface SanitizedCritiqueIssue {
  id: string;
  claim: null;
}

interface SanitizedCritique {
  summary: string;
  issues: SanitizedCritiqueIssue[];
}

interface SanitizedMetaIssue {
  verdict_reason: string;
  verdict: null;
}

interface SanitizedMeta {
  issues: SanitizedMetaIssue[];
  applied: unknown[];
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-branches.'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('stream-log rendering variants', () => {
  it('renders codex exec lifecycle events', () => {
    const started = streamJsonEvent(
      '{"type":"item.started","item":{"type":"command_execution","command":"/bin/zsh -lc \\"echo hi\\" in /repo","status":"in_progress"}}',
    ).map(stripAnsi);
    expect(started).toEqual(['    exec echo (1 args, 7 chars)']);
    const failed = streamJsonEvent(
      '{"type":"item.completed","item":{"type":"command_execution","command":"false","exit_code":2}}',
    ).map(stripAnsi);
    expect(failed).toEqual(['    exec failed(2) false (0 args, 5 chars)']);
    const content = streamJsonEvent(
      '{"type":"item.completed","item":{"content":[{"text":"first"},{"message":"second"},"third"]}}',
    ).map(stripAnsi);
    expect(content).toEqual(['    text (18 chars)']);
    const agent = streamJsonEvent('{"type":"agent_message","message":"hello\\nworld"}').map(
      stripAnsi,
    );
    expect(agent).toEqual(['    text (11 chars)']);
    expect(streamJsonEvent('{"type":"agent_message","message":""}')).toEqual([]);
    expect(streamJsonEvent('not json')).toEqual([]);
    expect(streamJsonEvent('[1,2]')).toEqual([]);
  });

  it('renders provider-neutral retry-shape fallbacks and omits unrecognized reasons', () => {
    expect(streamJsonEvent('{"retry":1}')).toEqual(['    api retry 1/? after ?ms']);
    const busy = streamJsonEvent(
      '{"type":"system","subtype":"will_retry","attempt":4,"maxRetries":9,"retry_after_ms":50,"reason":"busy"}',
    );
    expect(busy).toEqual(['    api retry 4/9 after 50ms']);
    expect(busy.join('\n')).not.toContain('busy');
  });

  it('renders cursor tool_call variants', () => {
    expect(
      cursorStreamJsonEvent(
        '{"type":"tool_call","subtype":"started","tool_call":{"readToolCall":{"args":{"path":"/a.ts"}}}}',
      ).map(stripAnsi),
    ).toEqual(['    Read /a.ts']);
    expect(
      cursorStreamJsonEvent(
        '{"type":"tool_call","subtype":"started","tool_call":{"writeToolCall":{"args":{"path":"/b.ts"}}}}',
      ).map(stripAnsi),
    ).toEqual(['    Write /b.ts']);
    expect(
      cursorStreamJsonEvent(
        '{"type":"tool_call","subtype":"started","tool_call":{"function":{"name":"grep","arguments":"-r x"}}}',
      ).map(stripAnsi),
    ).toEqual(['    grep (2 args, 4 chars)']);
    expect(
      cursorStreamJsonEvent('{"type":"tool_call","subtype":"started","tool_call":{}}').map(
        stripAnsi,
      ),
    ).toEqual(['    tool_call']);
    expect(
      cursorStreamJsonEvent(
        '{"type":"tool_call","subtype":"completed","tool_call":{"writeToolCall":{"args":{"path":"/c.ts"},"result":{"success":true}}}}',
      ).map(stripAnsi),
    ).toEqual(['    write completed /c.ts']);
    expect(
      cursorStreamJsonEvent(
        '{"type":"tool_call","subtype":"completed","tool_call":{"writeToolCall":{"result":{}}}}',
      ),
    ).toEqual([]);
    expect(
      cursorStreamJsonEvent(
        '{"type":"assistant","message":{"content":[{"type":"text","text":"hi"},{"type":"tool_use"}]}}',
      ).map(stripAnsi),
    ).toEqual(['    text (2 chars)']);
    expect(cursorStreamJsonEvent('broken')).toEqual([]);
  });

  it('filter passes through non-matching lines and disabled heartbeats', () => {
    const filter = new StreamLogFilter(0);
    expect(filter.line('plain text')).toEqual([]);
    expect(filter.line('{"type":"system","subtype":"thinking_tokens"}')).toEqual([]);
    expect(filter.line('{"type":"unknown"}')).toEqual([]);
  });
});

describe('sanitizer warning branches', () => {
  it('warns about unknown critique fields and version prefixes', () => {
    const file = path.join(tmp, 'critique.json');
    writeFileSync(
      file,
      `${JSON.stringify({
        plan_version: 0,
        summary: false,
        extra_top: 1,
        issues: [
          { id: 'v0.C1', bogus: true, severity: 'major' },
          { id: 'C2', another: 1 },
        ],
      })}\n`,
    );
    const capture = captureStderr();
    try {
      sanitizeCritiqueJson(file, 0);
      expect(capture.text()).toContain(
        'dropping unknown top-level fields from critique: extra_top',
      );
      expect(capture.text()).toContain('dropping unknown critique issue fields: another;bogus');
      expect(capture.text()).toContain('normalizing 1 critique issue id(s)');
    } finally {
      capture.restore();
    }
    const result = JSON.parse(readFileSync(file, 'utf8')) as SanitizedCritique;
    expect(result.summary).toBe('');
    expect(result.issues[0]?.id).toBe('C1');
    expect(result.issues[0]?.claim).toBeNull();
  });

  it('meta sanitizer fills jq alternatives and combine copies missing keys as null', () => {
    const meta = path.join(tmp, 'meta.json');
    writeFileSync(
      meta,
      `${JSON.stringify({ plan_version: 2, issues: [{ id: 'C1', verdict_reason: false }], unknown: 1 })}\n`,
    );
    const capture = captureStderr();
    try {
      sanitizeUpdateMetaJson(meta);
    } finally {
      capture.restore();
    }
    const sanitized = JSON.parse(readFileSync(meta, 'utf8')) as SanitizedMeta;
    expect(sanitized.issues[0]?.verdict_reason).toBe('');
    expect(sanitized.issues[0]?.verdict).toBeNull();
    expect(sanitized.applied).toEqual([]);

    const markdown = path.join(tmp, 'rev.md');
    writeFileSync(markdown, '# R\n');
    const sparse = path.join(tmp, 'sparse.json');
    writeFileSync(sparse, '{}\n');
    const out = path.join(tmp, 'combined.json');
    combineUpdateJson(sparse, markdown, out);
    expect(JSON.parse(readFileSync(out, 'utf8'))).toEqual({
      plan_version: null,
      plan_markdown: '# R\n',
      issues: null,
      applied: null,
      rejected_append: null,
    });
  });
});

describe('intervention ledger fallbacks', () => {
  it('renders invalid JSONL as numbered raw guidance', () => {
    const work = path.join(tmp, 'work');
    mkdirSync(work);
    writeFileSync(path.join(work, 'operator-interventions.jsonl'), 'not json\n{"id": broken\n');
    const context = operatorInterventionsContext(work, 'critic');
    expect(context).toContain('invalid JSONL');
    expect(context).toContain('     1\tnot json');
    expect(operatorInterventionsState(work)).toEqual({
      total: 'invalid',
      active: 'invalid',
      migrated: 'invalid',
    });
    markOperatorInterventionsMigrated(work, 'creator', 'plan.v1.md');
  });

  it('assigns fallback ids and indents multiline messages', () => {
    const work = path.join(tmp, 'work2');
    mkdirSync(work);
    writeFileSync(
      path.join(work, 'operator-interventions.jsonl'),
      `${JSON.stringify({ target: 'critic', message: 'line one\nline two' })}\n`,
    );
    const context = operatorInterventionsContext(work, 'critic');
    expect(context).toContain('- I1 [unknown-time, target=critic]');
    expect(context).toContain('  line one\n  line two');
    expect(operatorInterventionsContext(work, 'creator')).toBe('');
  });
});

describe('critic prompt helpers', () => {
  it('compacts critiques and renders topology variants', () => {
    const critique = path.join(tmp, 'critique.v0.json');
    writeCritique(critique, [
      {
        id: 'C1',
        addresses: null,
        severity: 'major',
        category: 'correctness',
        claim: 'first claim',
        evidence: 'e',
        suggested_fix: 'f',
        confidence: 1,
        duplicate_of: null,
      },
    ]);
    expect(compactCritiqueFile(critique)).toBe(
      '- critique.v0.json.C1 [major, correctness, addresses=new]: first claim',
    );
    const empty = path.join(tmp, 'critique.v1.json');
    writeCritique(empty, []);
    expect(compactCritiqueFile(empty)).toBe('- critique.v1.json: no issues');

    expect(topologyContext(tmp, 'compact')).toBe('');
    writeFileSync(path.join(tmp, 'ecosystem.yaml'), 'name: x\n');
    expect(topologyContext(tmp, 'compact')).toContain('## Repo topology summary');
    expect(topologyContext(tmp, 'full')).toContain('## Repo topology (ecosystem.yaml)\nname: x');
  });

  it('includes compact previous critiques and skips invalid ones', () => {
    const work = path.join(tmp, 'work');
    mkdirSync(work);
    writeFileSync(path.join(work, 'rejected-log.jsonl'), '');
    const plan = path.join(tmp, 'plan.md');
    writeFileSync(plan, '# Plan body\n');
    writeCritique(path.join(work, 'critique.v0.json'), [
      {
        id: 'C1',
        addresses: null,
        severity: 'major',
        category: 'correctness',
        claim: 'old claim',
        evidence: 'e',
        suggested_fix: 'f',
        confidence: 1,
        duplicate_of: null,
      },
    ]);
    writeFileSync(path.join(work, 'critique.v1.json'), '{"not": "a critique"}\n');
    const scratch = Scratch.create('critic-branch');
    const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'quick' });
    const capture = captureStderr();
    try {
      const prompt = criticPrompt(ctx, 2, plan);
      expect(prompt).toContain('## Previous critiques');
      expect(prompt).toContain('### critique.v0.json compact');
      expect(prompt).toContain(
        '- critique.v0.json.C1 [major, correctness, addresses=new]: old claim',
      );
      expect(capture.text()).toContain('skipping invalid previous critique: critique.v1.json');
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });
});

describe('config and knob halts', () => {
  function storeSettings(env: NodeJS.ProcessEnv, mutate: (settings: JsonObject) => void) {
    const config = defaultPlanLoopConfig();
    mutate(config.settings as JsonObject);
    writeFileSync(path.join(tmp, 'config.json'), `${JSON.stringify(config, null, 2)}\n`);
    return resolveConfig({ env, home: tmp }).config.settings;
  }

  it('preserves translate/locale precedence and validation through resolveConfig', () => {
    const capture = captureStderr();
    try {
      expect(() => storeSettings({}, (s) => (s.translate = 'maybe'))).toThrow(
        /settings\.translate must be true or false/,
      );
      const onOff = storeSettings({}, (s) => (s.translate = 'on'));
      expect(onOff.translatePass).toBe(1);
      expect(onOff.locale).toBe('ru');
      expect(
        storeSettings({ AGENT_QUORUM_TRANSLATE: 'off' }, (s) => (s.translate = 'on')).translatePass,
      ).toBe(0);
      const localeSettings = storeSettings({}, (s) => {
        Reflect.deleteProperty(s, 'translate');
        s.locale = 'pt-BR';
      });
      expect(localeSettings.translatePass).toBe(1);
      expect(localeSettings.locale).toBe('pt-BR');
      const defaultLocaleSettings = storeSettings({}, (s) =>
        Reflect.deleteProperty(s, 'translate'),
      );
      expect(defaultLocaleSettings.translatePass).toBe(0);
      expect(defaultLocaleSettings.locale).toBe('en');
      const englishSettings = storeSettings({}, (s) => {
        Reflect.deleteProperty(s, 'translate');
        s.locale = 'en';
      });
      expect(englishSettings.translatePass).toBe(0);
      expect(englishSettings.locale).toBe('en');
      expect(() =>
        storeSettings({}, (s) => {
          Reflect.deleteProperty(s, 'translate');
          s.locale = '../ru';
        }),
      ).toThrow(/settings\.locale/);
    } finally {
      capture.restore();
    }
  });

  it('projects resolved watchdog knobs and enforces a positive claude poll', () => {
    const resolved = (env: NodeJS.ProcessEnv = {}) => resolveConfig({ env, home: tmp }).config;
    const knobs = resolveWatchdogKnobs(resolved());
    expect(knobs.stream.claude.wallTimeoutSeconds).toBe(1800);
    expect(knobs.translatePass.retryCount).toBe(1);
    const capture = captureStderr();
    try {
      expect(() =>
        resolveConfig({ env: { AGENT_QUORUM_CLAUDE_STALL_TIMEOUT_SECONDS: 'soon' }, home: tmp }),
      ).toThrow(HaltError);
    } finally {
      capture.restore();
    }
    expect(() =>
      resolveWatchdogKnobs(resolved({ AGENT_QUORUM_CLAUDE_STALL_POLL_SECONDS: '0' })),
    ).toThrow(/expects a positive integer/);
  });

  it('does not require a positive cursor poll yet still validates cursor stream env', () => {
    const resolved = (env: NodeJS.ProcessEnv = {}) => resolveConfig({ env, home: tmp }).config;
    expect(() =>
      resolveWatchdogKnobs(resolved({ AGENT_QUORUM_CURSOR_STALL_POLL_SECONDS: '0' })),
    ).not.toThrow();
    const capture = captureStderr();
    try {
      expect(() =>
        resolveConfig({ env: { AGENT_QUORUM_CURSOR_STALL_TIMEOUT_SECONDS: 'soon' }, home: tmp }),
      ).toThrow(HaltError);
    } finally {
      capture.restore();
    }
  });
});

describe('exec escalation', () => {
  it('escalates SIGINT to SIGTERM for children that ignore INT', async () => {
    const child = spawnDetached('sh', ['-c', "trap '' INT; sleep 30"], { stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await interruptThenTerminate(child, 1);
    const status = await waitForExit(child);
    expect(status).toBe(143);
  }, 15_000);
});
