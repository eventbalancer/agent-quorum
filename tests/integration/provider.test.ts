import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { providerRun } from '../../src/providers/provider.js';
import type { ProviderRuntime } from '../../src/providers/runtime.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { fixtureMatrix } from '../helpers/test-context.js';
import {
  argvRecords,
  captureStderr,
  emptyCritique,
  SKILLS_DIR,
  withEnvAsync,
  writeFakeBin,
  writeMarkdownWrapper,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';

const CRITIC_SKILL = path.join(SKILLS_DIR, 'plan-critic', 'SKILL.md');
const CRITIC_SCHEMA = path.join(SKILLS_DIR, 'plan-critic', 'critique.schema.json');
const CREATOR_SKILL = path.join(SKILLS_DIR, 'plan-creator', 'SKILL.md');
const TOOLS = 'Read,Grep,Glob';
const DISALLOWED = 'Write,Edit,NotebookEdit,Bash,Agent,Task,ToolSearch,AskUserQuestion';

let tmp: string;
let fake: string;
let scratch: Scratch;
let capture: StderrCapture;

function makeRuntime(partial?: Partial<ProviderRuntime>): ProviderRuntime {
  return {
    scratch,
    projectRoot: tmp,
    retry: { retryCount: 3, retryDelaySeconds: 0 },
    claudeKnobs: {
      stallStatus: 124,
      pollSeconds: 1,
      graceSeconds: 1,
      byteTimeoutSeconds: 0,
      semanticTimeoutSeconds: 0,
      wallTimeoutSeconds: 0,
    },
    cursorKnobs: {
      stallStatus: 124,
      pollSeconds: 1,
      graceSeconds: 1,
      byteTimeoutSeconds: 0,
      semanticTimeoutSeconds: 0,
      wallTimeoutSeconds: 0,
    },
    matrix: fixtureMatrix(),
    sessionMode: 0,
    creatorSessionFile: path.join(tmp, 'creator.session-id'),
    markdownSchemaPath: path.join(SKILLS_DIR, '_shared', 'markdown.schema.json'),
    cursorBin: 'cursor-agent',
    ...partial,
  };
}

function strippedFile(file: string): string {
  return readFileSync(file, 'utf8').replace(/\n+$/, '');
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-provider.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  scratch = Scratch.create('provider-test');
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  scratch.sweep();
  rmSync(tmp, { recursive: true, force: true });
});

function fakePath(): string {
  return `${fake}:${process.env.PATH ?? ''}`;
}

describe('claude argv contract', () => {
  it('json mode argv byte-matches the reference order', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'out.json');
    const argvLog = path.join(tmp, 'claude.argv');
    const rt = makeRuntime({
      matrix: {
        ...fixtureMatrix(),
        critic: { runner: 'claude', model: 'claude-sonnet-4-6', reasoning: 'xhigh' },
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_JSON_RESULT: critique,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
      },
      () =>
        providerRun(
          rt,
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          TOOLS,
          DISALLOWED,
          'PROMPT BODY\n',
        ),
    );

    expect(status).toBe(0);
    const records = argvRecords(argvLog);
    expect(records).toEqual([
      [
        '-p',
        '--verbose',
        '--output-format',
        'stream-json',
        '--append-system-prompt',
        strippedFile(CRITIC_SKILL),
        '--permission-mode',
        'plan',
        '--model',
        'claude-sonnet-4-6',
        '--json-schema',
        strippedFile(CRITIC_SCHEMA),
        '--effort',
        'xhigh',
        '--tools',
        TOOLS,
        '--allowed-tools',
        TOOLS,
        '--disallowed-tools',
        DISALLOWED,
      ],
    ]);
    expect(readFileSync(out, 'utf8')).toBe(strippedFile(critique));
  });

  it('creator create receives the configured Bash grant verbatim (Finding F9)', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const out = path.join(tmp, 'plan.v0.md');
    const argvLog = path.join(tmp, 'claude.argv');
    const rt = makeRuntime();
    const createTools = 'Read,Grep,Glob,Bash';
    const createDisallowed = 'Write,Edit,NotebookEdit,Agent,Task,ToolSearch,AskUserQuestion';

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
      },
      () =>
        providerRun(
          rt,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          createTools,
          createDisallowed,
          'Create.\n',
        ),
    );

    expect(status).toBe(0);
    const record = argvRecords(argvLog)[0] ?? [];
    expect(record).not.toContain('--json-schema');
    const toolsIdx = record.indexOf('--tools');
    const allowedIdx = record.indexOf('--allowed-tools');
    const disallowedIdx = record.indexOf('--disallowed-tools');
    const permIdx = record.indexOf('--permission-mode');
    expect(record[toolsIdx + 1]).toBe(createTools);
    expect(record[allowedIdx + 1]).toBe(createTools);
    expect(record[disallowedIdx + 1]).toBe(createDisallowed);
    expect(record[permIdx + 1]).toBe('plan');
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(created, 'utf8'));
  });
});

describe('claude sessions', () => {
  it('establishes a session then resumes it', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const out = path.join(tmp, 'out.md');
    const argvLog = path.join(tmp, 'claude.argv');
    const rt = makeRuntime({ sessionMode: 1 });

    const env = {
      PATH: fakePath(),
      FAKE_CLAUDE_MARKDOWN_RESULT: created,
      FAKE_CLAUDE_ARGV_LOG: argvLog,
    };
    expect(
      await withEnvAsync(env, () =>
        providerRun(
          rt,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'First.\n',
        ),
      ),
    ).toBe(0);
    const sessionId = readFileSync(rt.creatorSessionFile, 'utf8').trim();
    expect(sessionId).toMatch(/^[0-9a-f-]{36}$/);

    expect(
      await withEnvAsync(env, () =>
        providerRun(
          rt,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Second.\n',
        ),
      ),
    ).toBe(0);

    const records = argvRecords(argvLog);
    expect(records).toHaveLength(2);
    expect(records[0]).toContain('--session-id');
    const first = records[0] ?? [];
    expect(first[first.indexOf('--session-id') + 1]).toBe(sessionId);
    expect(records[1]).toContain('--resume');
    const second = records[1] ?? [];
    expect(second[second.indexOf('--resume') + 1]).toBe(sessionId);
  });

  it('re-establishes a fresh session when resume fails', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const out = path.join(tmp, 'out.md');
    const argvLog = path.join(tmp, 'claude.argv');
    const rt = makeRuntime({ sessionMode: 1, retry: { retryCount: 0, retryDelaySeconds: 0 } });
    const staleId = '00000000-0000-4000-8000-00000000dead';
    writeFileSync(rt.creatorSessionFile, `${staleId}\n`);

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
        FAKE_CLAUDE_FAIL_ON_RESUME: '1',
      },
      () =>
        providerRun(
          rt,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Heal.\n',
        ),
    );

    expect(status).toBe(0);
    const records = argvRecords(argvLog);
    expect(records).toHaveLength(2);
    expect(records[0]).toContain('--resume');
    expect(records[1]).toContain('--session-id');
    const newId = readFileSync(rt.creatorSessionFile, 'utf8').trim();
    expect(newId).not.toBe(staleId);
    expect(capture.text()).toContain('creator session resume failed; re-establishing session');
  });

  it('resumes the same session once after a watchdog stall', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const out = path.join(tmp, 'out.md');
    const argvLog = path.join(tmp, 'claude.argv');
    const stallCounter = path.join(tmp, 'stall.count');
    const rt = makeRuntime({
      sessionMode: 1,
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      claudeKnobs: {
        stallStatus: 124,
        pollSeconds: 1,
        graceSeconds: 1,
        byteTimeoutSeconds: 1,
        semanticTimeoutSeconds: 0,
        wallTimeoutSeconds: 0,
      },
    });
    const liveId = '00000000-0000-4000-8000-0000000000aa';
    writeFileSync(rt.creatorSessionFile, `${liveId}\n`);

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_ARGV_LOG: argvLog,
        FAKE_CLAUDE_STALL_ONCE: stallCounter,
      },
      () =>
        providerRun(
          rt,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Stall.\n',
        ),
    );

    expect(status).toBe(0);
    expect(capture.text()).toContain('claude stream stalled');
    expect(capture.text()).toContain('creator stream stalled; resuming the same session once');
    const records = argvRecords(argvLog);
    expect(records).toHaveLength(2);
    const resumeRecord = records[1] ?? [];
    expect(resumeRecord[resumeRecord.indexOf('--resume') + 1]).toBe(liveId);
  }, 30_000);
});

describe('claude watchdog', () => {
  it('semantic idle terminates an api-retry loop', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const rt = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      claudeKnobs: {
        stallStatus: 124,
        pollSeconds: 1,
        graceSeconds: 1,
        byteTimeoutSeconds: 0,
        semanticTimeoutSeconds: 2,
        wallTimeoutSeconds: 0,
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_API_RETRY_LOOP_ONCE: path.join(tmp, 'retry.loop'),
      },
      () =>
        providerRun(
          makeRuntime({ ...rt }),
          'creator',
          'markdown',
          path.join(tmp, 'o.md'),
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'X\n',
        ),
    );

    expect(status).toBe(124);
    expect(capture.text()).toContain('no semantic progress');
  }, 30_000);

  it('thinking heartbeats defer semantic idle until the wall clock fires', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const rt = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      claudeKnobs: {
        stallStatus: 124,
        pollSeconds: 1,
        graceSeconds: 1,
        byteTimeoutSeconds: 0,
        semanticTimeoutSeconds: 2,
        wallTimeoutSeconds: 5,
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_THINKING_LOOP_ONCE: path.join(tmp, 'thinking.loop'),
      },
      () =>
        providerRun(
          rt,
          'creator',
          'markdown',
          path.join(tmp, 'o.md'),
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'X\n',
        ),
    );

    expect(status).toBe(124);
    expect(capture.text()).toContain('wall-clock timeout');
    expect(capture.text()).not.toContain('no semantic progress');
  }, 30_000);

  it('wall-clock timeout terminates a busy stream', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Created');
    const rt = makeRuntime({
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      claudeKnobs: {
        stallStatus: 124,
        pollSeconds: 1,
        graceSeconds: 1,
        byteTimeoutSeconds: 0,
        semanticTimeoutSeconds: 0,
        wallTimeoutSeconds: 3,
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CLAUDE_MARKDOWN_RESULT: created,
        FAKE_CLAUDE_WALLCLOCK_LOOP_ONCE: path.join(tmp, 'wall.loop'),
      },
      () =>
        providerRun(
          rt,
          'creator',
          'markdown',
          path.join(tmp, 'o.md'),
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'X\n',
        ),
    );

    expect(status).toBe(124);
    expect(capture.text()).toContain('wall-clock timeout');
  }, 30_000);
});

describe('codex argv and retries', () => {
  it('argv byte-matches the stateless read-only contract', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'critique.out.json');
    const argvLog = path.join(tmp, 'codex.argv');
    const promptCapture = path.join(tmp, 'codex.prompt');
    const rt = makeRuntime();

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: promptCapture,
        FAKE_CODEX_ARGV_LOG: argvLog,
      },
      () =>
        providerRun(
          rt,
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'PROMPT BODY\n',
        ),
    );

    expect(status).toBe(0);
    const fullPrompt = `${strippedFile(CRITIC_SKILL)}\n\nPROMPT BODY`;
    expect(argvRecords(argvLog)).toEqual([
      [
        'exec',
        '--sandbox',
        'read-only',
        '--skip-git-repo-check',
        '--color',
        'never',
        '-m',
        'gpt-5.5',
        '-c',
        'model_reasoning_effort="xhigh"',
        '--output-schema',
        CRITIC_SCHEMA,
        '-o',
        out,
        '--',
        fullPrompt,
      ],
    ]);
    expect(readFileSync(promptCapture, 'utf8')).toBe(fullPrompt);
    expect(existsSync(path.join(tmp, 'critic.session-id'))).toBe(false);
  });

  it('extracts plan markdown through the wrapper schema', async () => {
    const wrapper = path.join(tmp, 'wrapper.json');
    writeMarkdownWrapper(wrapper, 'Wrapped Plan');
    const out = path.join(tmp, 'plan.md');
    const rt = makeRuntime({
      matrix: {
        ...fixtureMatrix(),
        creator: { runner: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' },
      },
    });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: wrapper,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () => providerRun(rt, 'creator', 'markdown', out, CREATOR_SKILL, '', '', '', 'Create.\n'),
    );

    expect(status).toBe(0);
    const wrapped = JSON.parse(readFileSync(wrapper, 'utf8')) as { plan_markdown: string };
    expect(readFileSync(out, 'utf8')).toBe(`${wrapped.plan_markdown}\n`);
    expect(readFileSync(out, 'utf8')).toContain('Edge chars: "quoted" and backslash \\');
  });

  it('recovers through provider retries on transient failures', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'out.json');
    const attempts = path.join(tmp, 'attempts');

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_ATTEMPTS: attempts,
        FAKE_CODEX_FAILS: '2',
      },
      () =>
        providerRun(
          makeRuntime(),
          'critic',
          'json',
          out,
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(0);
    expect(readFileSync(attempts, 'utf8')).toBe('3');
    expect(capture.text()).toContain('WARNING: codex call failed; retry 1/3');
  });

  it('returns the last failure status when retries are exhausted', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const attempts = path.join(tmp, 'attempts');
    const rt = makeRuntime({ retry: { retryCount: 1, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: critique,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
        FAKE_CODEX_ATTEMPTS: attempts,
        FAKE_CODEX_FAILS: '9',
      },
      () =>
        providerRun(
          rt,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(1);
    expect(readFileSync(attempts, 'utf8')).toBe('2');
    expect(capture.text()).toContain('codex call failed after 2 attempt(s)');
  });

  it('maps empty codex output to status 4', async () => {
    const empty = path.join(tmp, 'empty.json');
    writeFileSync(empty, '');
    const rt = makeRuntime({ retry: { retryCount: 0, retryDelaySeconds: 0 } });

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CODEX_OUTPUT: empty,
        FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
      },
      () =>
        providerRun(
          rt,
          'critic',
          'json',
          path.join(tmp, 'out.json'),
          CRITIC_SKILL,
          CRITIC_SCHEMA,
          '',
          '',
          'P\n',
        ),
    );

    expect(status).toBe(4);
    expect(capture.text()).toContain('codex produced empty output');
  });
});

describe('cursor adapter', () => {
  it('builds capability-probed argv, injects prompt hints, captures the session', async () => {
    const critique = path.join(tmp, 'critique.json');
    emptyCritique(critique);
    const out = path.join(tmp, 'out.json');
    const argvLog = path.join(tmp, 'cursor.argv');
    const promptCapture = path.join(tmp, 'cursor.prompt');
    const rt = makeRuntime({
      sessionMode: 1,
      matrix: {
        ...fixtureMatrix(),
        creator: { runner: 'cursor', model: 'composer-2.5', reasoning: 'high' },
      },
    });

    const env = {
      PATH: fakePath(),
      FAKE_CURSOR_JSON_RESULT: critique,
      FAKE_CURSOR_ARGV_LOG: argvLog,
      FAKE_CURSOR_PROMPT: promptCapture,
    };
    const status = await withEnvAsync(env, () =>
      providerRun(
        rt,
        'creator',
        'json',
        out,
        CREATOR_SKILL,
        CRITIC_SCHEMA,
        TOOLS,
        DISALLOWED,
        'Update.\n',
      ),
    );

    expect(status).toBe(0);
    expect(capture.text()).toContain(
      'WARNING: cursor runner ignores reasoning/effort field (reasoning=high)',
    );
    const records = argvRecords(argvLog);
    expect(records).toEqual([
      [
        '-p',
        '--output-format',
        'stream-json',
        '--workspace',
        tmp,
        '--model',
        'composer-2.5',
        '--trust',
        '--approve-mcps',
      ],
    ]);
    const prompt = readFileSync(promptCapture, 'utf8');
    expect(prompt.startsWith(strippedFile(CREATOR_SKILL))).toBe(true);
    expect(prompt).toContain('## Tool constraints');
    expect(prompt).toContain(`Use only these tools when inspecting the codebase: ${TOOLS}.`);
    expect(prompt).toContain('## JSON schema');
    expect(readFileSync(rt.creatorSessionFile, 'utf8')).toBe('cursor-session-fixture');
    expect(readFileSync(out, 'utf8')).toBe(strippedFile(critique));

    const status2 = await withEnvAsync(env, () =>
      providerRun(
        rt,
        'creator',
        'json',
        out,
        CREATOR_SKILL,
        CRITIC_SCHEMA,
        TOOLS,
        DISALLOWED,
        'Again.\n',
      ),
    );
    expect(status2).toBe(0);
    const second = argvRecords(argvLog)[1] ?? [];
    expect(second[second.indexOf('--resume') + 1]).toBe('cursor-session-fixture');
  });

  it('runs markdown mode and re-establishes a session when resume fails', async () => {
    const created = path.join(tmp, 'created.md');
    writeStructuredPlanFile(created, 'Cursor Created');
    const out = path.join(tmp, 'out.md');
    const argvLog = path.join(tmp, 'cursor.argv');
    const rt = makeRuntime({
      sessionMode: 1,
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      matrix: {
        ...fixtureMatrix(),
        creator: { runner: 'cursor', model: 'composer-2.5', reasoning: '' },
      },
    });
    writeFileSync(rt.creatorSessionFile, 'stale-cursor-session');

    const status = await withEnvAsync(
      {
        PATH: fakePath(),
        FAKE_CURSOR_MARKDOWN_RESULT: created,
        FAKE_CURSOR_ARGV_LOG: argvLog,
        FAKE_CURSOR_FAIL_ON_RESUME: '1',
      },
      () =>
        providerRun(
          rt,
          'creator',
          'markdown',
          out,
          CREATOR_SKILL,
          '',
          TOOLS,
          DISALLOWED,
          'Heal.\n',
        ),
    );

    expect(status).toBe(0);
    expect(capture.text()).toContain(
      'creator cursor session resume failed; re-establishing session',
    );
    const records = argvRecords(argvLog);
    expect(records).toHaveLength(2);
    expect(records[0]).toContain('--resume');
    expect(records[1]).not.toContain('--resume');
    expect(readFileSync(out, 'utf8')).toBe(readFileSync(created, 'utf8'));
    expect(readFileSync(rt.creatorSessionFile, 'utf8')).toBe('cursor-session-fixture');
  });
});
