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
} from '../../src/core/interventions.js';
import { compactCritiqueFile, criticPrompt, topologyContext } from '../../src/core/critic.js';
import { resetConfigCache, resolveRunSettings } from '../../src/core/config.js';
import { resolveWatchdogKnobs } from '../../src/core/knobs.js';
import { HaltError } from '../../src/runtime/halt.js';
import { interruptThenTerminate, spawnDetached, waitForExit } from '../../src/runtime/exec.js';
import {
  captureStderr,
  defaultPlanLoopConfig,
  stripAnsi,
  withEnv,
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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-branches.'));
  resetConfigCache();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('stream-log rendering variants', () => {
  it('renders codex exec lifecycle events', () => {
    const started = streamJsonEvent(
      '{"type":"item.started","item":{"type":"command_execution","command":"/bin/zsh -lc \\"echo hi\\" in /repo","status":"in_progress"}}',
    ).map(stripAnsi);
    expect(started).toEqual(['    exec echo hi']);
    const failed = streamJsonEvent(
      '{"type":"item.completed","item":{"type":"command_execution","command":"false","exit_code":2}}',
    ).map(stripAnsi);
    expect(failed).toEqual(['    exec failed(2) false']);
    const content = streamJsonEvent(
      '{"type":"item.completed","item":{"content":[{"text":"first"},{"message":"second"},"third"]}}',
    ).map(stripAnsi);
    expect(content).toEqual(['    first second third']);
    const agent = streamJsonEvent('{"type":"agent_message","message":"hello\\nworld"}').map(
      stripAnsi,
    );
    expect(agent).toEqual(['    hello']);
    expect(streamJsonEvent('{"type":"agent_message","message":""}')).toEqual([]);
    expect(streamJsonEvent('not json')).toEqual([]);
    expect(streamJsonEvent('[1,2]')).toEqual([]);
  });

  it('renders retry-shape fallbacks', () => {
    expect(streamJsonEvent('{"retry":1}')).toEqual(['    claude api retry 1/? after ?ms: unknown']);
    expect(
      streamJsonEvent(
        '{"type":"system","subtype":"will_retry","attempt":4,"maxRetries":9,"retry_after_ms":50,"reason":"busy"}',
      ),
    ).toEqual(['    claude api retry 4/9 after 50ms: busy']);
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
    ).toEqual(['    grep -r x']);
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
    ).toEqual(['    hi']);
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
    const ctx = makeTestRunContext(tmp, work, scratch, { effort: 'low' });
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
  function writeConfig(name: string, mutate: (config: JsonObject) => void): string {
    const config = defaultPlanLoopConfig();
    mutate(config);
    const file = path.join(tmp, name);
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
    return file;
  }

  it('halts on missing version/settings/roles and invalid translate', () => {
    const capture = captureStderr();
    try {
      const noVersion = writeConfig('no-version.json', (config) => {
        Reflect.deleteProperty(config, 'version');
      });
      expect(() => resolveRunSettings({}, noVersion)).toThrow(/missing required field version/);
      resetConfigCache();
      const noSettings = writeConfig('no-settings.json', (config) => {
        Reflect.deleteProperty(config, 'settings');
      });
      expect(() => resolveRunSettings({}, noSettings)).toThrow(/missing required object settings/);
      resetConfigCache();
      const noRoles = writeConfig('no-roles.json', (config) => {
        Reflect.deleteProperty(config, 'roles');
      });
      expect(() => resolveRunSettings({}, noRoles)).toThrow(/missing required object roles/);
      resetConfigCache();
      const file = writeConfig('translate.json', (config) => {
        (config.settings as JsonObject).translate = 'maybe';
      });
      expect(() => resolveRunSettings({}, file)).toThrow(
        /settings\.translate must be true or false/,
      );
      resetConfigCache();
      const onOff = writeConfig('translate-on.json', (config) => {
        (config.settings as JsonObject).translate = 'on';
      });
      expect(resolveRunSettings({}, onOff).translatePass).toBe(1);
      expect(resolveRunSettings({}, onOff).locale).toBe('ru');
      expect(
        withEnv({ PLAN_LOOP_TRANSLATE: 'off' }, () => resolveRunSettings({}, onOff)).translatePass,
      ).toBe(0);
      resetConfigCache();
      const localeOn = writeConfig('locale-on.json', (config) => {
        Reflect.deleteProperty(config.settings as JsonObject, 'translate');
        (config.settings as JsonObject).locale = 'pt-BR';
      });
      const localeSettings = resolveRunSettings({}, localeOn);
      expect(localeSettings.translatePass).toBe(1);
      expect(localeSettings.locale).toBe('pt-BR');
      resetConfigCache();
      const defaultLocale = writeConfig('default-locale.json', (config) => {
        Reflect.deleteProperty(config.settings as JsonObject, 'translate');
      });
      const defaultLocaleSettings = resolveRunSettings({}, defaultLocale);
      expect(defaultLocaleSettings.translatePass).toBe(0);
      expect(defaultLocaleSettings.locale).toBe('en');
      resetConfigCache();
      const englishLocale = writeConfig('english-locale.json', (config) => {
        Reflect.deleteProperty(config.settings as JsonObject, 'translate');
        (config.settings as JsonObject).locale = 'en';
      });
      const englishSettings = resolveRunSettings({}, englishLocale);
      expect(englishSettings.translatePass).toBe(0);
      expect(englishSettings.locale).toBe('en');
      resetConfigCache();
      const invalidLocale = writeConfig('invalid-locale.json', (config) => {
        Reflect.deleteProperty(config.settings as JsonObject, 'translate');
        (config.settings as JsonObject).locale = '../ru';
      });
      expect(() => resolveRunSettings({}, invalidLocale)).toThrow(/settings\.locale/);
    } finally {
      capture.restore();
    }
  });

  it('validates watchdog knobs with reference messages and defaults', () => {
    const knobs = resolveWatchdogKnobs();
    expect(knobs.claude.wallTimeoutSeconds).toBe(1800);
    expect(knobs.translatePass.retryCount).toBe(1);
    expect(() =>
      withEnv({ PLAN_LOOP_CLAUDE_STALL_TIMEOUT_SECONDS: 'soon' }, () => resolveWatchdogKnobs()),
    ).toThrow(HaltError);
    expect(() =>
      withEnv({ PLAN_LOOP_CLAUDE_STALL_POLL_SECONDS: '0' }, () => resolveWatchdogKnobs()),
    ).toThrow(/expects a positive integer/);
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
