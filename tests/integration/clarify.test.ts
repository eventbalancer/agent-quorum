import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clarifyGateEnabled, runClarificationGate } from '../../src/stages/plan/clarify.js';
import { ExitCode, runPlanLoop } from '../../src/index.js';
import { resetConfigCache } from '../../src/core/config.js';
import { Scratch } from '../../src/runtime/scratch.js';
import {
  captureStderr,
  withEnv,
  withEnvAsync,
  writeDefaultPlanLoopConfig,
  writeFakeBin,
  type StderrCapture,
} from '../helpers/harness.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import { startTelegramStub, type TelegramStub } from '../helpers/telegram-stub.js';

async function waitForSent(stub: TelegramStub, match: string, timeoutMs = 4000): Promise<number> {
  const start = Date.now();
  for (;;) {
    const index = stub.sent.findIndex((text) => text.includes(match));
    if (index >= 0) {
      return index + 1;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for a sent message containing "${match}"`);
    }
    await sleep(20);
  }
}

const FIXED_QUESTIONS = {
  questions: [
    {
      id: 'Q1',
      question: 'Which regions are in scope?',
      why: 'changes the deployment matrix',
      options: ['IO only', 'RU only', 'IO and RU'],
    },
    {
      id: 'Q2',
      question: 'Hard cutover or phased?',
      why: 'changes the sequencing',
      options: ['Hard cutover', 'Phased'],
    },
  ],
};

let tmp: string;
let work: string;
let scratch: Scratch;
let capture: StderrCapture;
let stub: TelegramStub;

function seedQuestions(
  questions: unknown = FIXED_QUESTIONS,
  options: { offset?: boolean } = {},
): void {
  writeFileSync(
    path.join(work, 'clarify-questions.json'),
    `${JSON.stringify(questions, null, 2)}\n`,
  );
  if (options.offset !== false) {
    writeFileSync(path.join(work, 'clarify.offset'), '0');
  }
}

function gateEnv(): Record<string, string | undefined> {
  return {
    AGENT_QUORUM_TELEGRAM_BOT_TOKEN: 't',
    AGENT_QUORUM_TELEGRAM_CHAT_ID: '42',
    AGENT_QUORUM_TELEGRAM_API_BASE: stub.baseUrl,
    AGENT_QUORUM_TELEGRAM_STATE_DIR: path.join(tmp, 'tg-state'),
    AGENT_QUORUM_TELEGRAM_POLL_TIMEOUT: '1',
    AGENT_QUORUM_TELEGRAM_HTTP_TIMEOUT: '1',
    AGENT_QUORUM_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS: '1',
    AGENT_QUORUM_TELEGRAM_RECEIVE_BACKOFF_SECONDS: '1',
    AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '3',
    AGENT_QUORUM_CLARIFY: undefined,
  };
}

function readJsonl(file: string): Record<string, unknown>[] {
  return readFileSync(file, 'utf8')
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

beforeEach(async () => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-clarifytest.'));
  work = path.join(tmp, 'work');
  mkdirSync(work);
  scratch = Scratch.create('clarify-test');
  capture = captureStderr();
  stub = await startTelegramStub();
  writeFileSync(path.join(tmp, 'prompt.md'), 'Make a plan.\n');
});

afterEach(async () => {
  capture.restore();
  scratch.sweep();
  await stub.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe('clarify gate enablement', () => {
  it('honors AGENT_QUORUM_CLARIFY and credentials', () => {
    expect(
      withEnv(
        {
          AGENT_QUORUM_TELEGRAM_BOT_TOKEN: 't',
          AGENT_QUORUM_TELEGRAM_CHAT_ID: '42',
          AGENT_QUORUM_CLARIFY: 'auto',
        },
        () => clarifyGateEnabled(),
      ),
    ).toBe('run');
    expect(
      withEnv(
        {
          AGENT_QUORUM_TELEGRAM_BOT_TOKEN: 't',
          AGENT_QUORUM_TELEGRAM_CHAT_ID: '42',
          AGENT_QUORUM_CLARIFY: '0',
        },
        () => clarifyGateEnabled(),
      ),
    ).toBe('skip');
    expect(
      withEnv(
        {
          AGENT_QUORUM_TELEGRAM_BOT_TOKEN: undefined,
          AGENT_QUORUM_TELEGRAM_CHAT_ID: undefined,
          AGENT_QUORUM_CLARIFY: 'auto',
        },
        () => clarifyGateEnabled(),
      ),
    ).toBe('skip');
    expect(
      withEnv(
        {
          AGENT_QUORUM_TELEGRAM_BOT_TOKEN: undefined,
          AGENT_QUORUM_TELEGRAM_CHAT_ID: undefined,
          AGENT_QUORUM_CLARIFY: '1',
        },
        () => clarifyGateEnabled(),
      ),
    ).toBe('error');
  });
});

describe('clarification gate', () => {
  it('blocks per question, records answers, and folds them into interventions', async () => {
    seedQuestions();
    stub.queueReply(100, 'IO and RU');
    stub.queueReply(101, 'Hard cutover');
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(work, 'clarify.done'))).toBe(true);
    const answers = readJsonl(path.join(work, 'clarify-answers.jsonl'));
    expect(answers).toHaveLength(2);
    expect(answers[0]?.answer).toBe('IO and RU');
    expect(answers[1]?.answer).toBe('Hard cutover');

    const interventions = readJsonl(path.join(work, 'operator-interventions.jsonl'));
    expect(interventions).toHaveLength(2);
    expect(
      interventions.every(
        (entry) =>
          entry.target === 'all' &&
          typeof entry.message === 'string' &&
          entry.message.startsWith('Operator clarification —'),
      ),
    ).toBe(true);
    expect(JSON.stringify(interventions)).toContain('IO and RU');

    const sent = stub.sent.join('\n');
    expect(sent).toContain('Question 1/2');
    expect(sent).toContain('Question 2/2');
    expect(sent).toContain('Options');
    expect(sent).toContain('1. IO only');
    expect(sent).toContain('all 2');
  });

  it('maps a bare number to the matching option', async () => {
    seedQuestions();
    stub.queueReply(100, '3');
    stub.queueReply(101, '1');
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(true);
    const answers = readJsonl(path.join(work, 'clarify-answers.jsonl'));
    expect(answers[0]?.answer).toBe('IO and RU');
    expect(answers[1]?.answer).toBe('Hard cutover');
    expect(readFileSync(path.join(work, 'operator-interventions.jsonl'), 'utf8')).toContain(
      'IO and RU',
    );
  });

  it('uses Russian Telegram copy when locale is ru', async () => {
    seedQuestions({
      questions: [
        {
          id: 'Q1',
          question: 'Какие регионы включаем?',
          why: 'От этого зависит матрица выкладки.',
          options: ['Только IO', 'IO и RU'],
        },
      ],
    });
    stub.queueReply(150, '2');
    const ctx = makeTestRunContext(tmp, work, scratch, { locale: 'ru', translatePass: 1 });

    const result = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(true);
    const sent = stub.sent.join('\n');
    expect(sent).toContain('Вопрос 1/1');
    expect(sent).toContain('Варианты');
    expect(sent).toContain('Готово');
    expect(readJsonl(path.join(work, 'clarify-answers.jsonl'))[0]?.answer).toBe('IO и RU');
  });

  it('is a no-op when the creator raises no blocking questions', async () => {
    seedQuestions({ questions: [] });
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(true);
    expect(existsSync(path.join(work, 'clarify.done'))).toBe(true);
    expect(stub.sent).toHaveLength(0);
  });

  it('resume reuses questions and only asks the unanswered ones', async () => {
    seedQuestions({
      questions: [
        { id: 'Q1', question: 'Which regions?', why: 'deployment matrix', options: ['IO', 'RU'] },
        {
          id: 'Q2',
          question: 'Cutover style?',
          why: 'sequencing',
          options: ['Hard', 'Phased'],
        },
      ],
    });
    writeFileSync(
      path.join(work, 'clarify-answers.jsonl'),
      `${JSON.stringify({ id: 'Q1', question: 'Which regions?', answer: 'IO only', ts: 't' })}\n`,
    );
    stub.queueReply(300, 'Staged');
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(true);
    const sent = stub.sent.join('\n');
    expect(sent).not.toContain('Question 1/2');
    expect(sent).toContain('Question 2/2');
    expect(sent).not.toContain('I need to clarify');
    expect(readJsonl(path.join(work, 'clarify-answers.jsonl'))).toHaveLength(2);
  });

  it('/cancel aborts the gate', async () => {
    seedQuestions();
    stub.queueReply(400, '/cancel');
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(7);
    }
    expect(existsSync(path.join(work, 'clarify.done'))).toBe(false);
    expect(capture.text()).toContain('operator sent /cancel — aborting run');
  });

  it('deadline expiry aborts the gate', async () => {
    seedQuestions();
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(
      {
        ...gateEnv(),
        AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '1',
        AGENT_QUORUM_TELEGRAM_POLL_TIMEOUT: '1',
      },
      () => runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(7);
    }
    expect(capture.text()).toContain('timed out after 1s waiting for Q1');
    expect(existsSync(path.join(work, 'clarify.done'))).toBe(false);
  }, 30_000);
});

function singleQuestion(question: string): unknown {
  return { questions: [{ id: 'Q1', question, why: 'matters', options: ['A', 'B'] }] };
}

describe('clarification gate concurrency and failures', () => {
  it('routes each operator reply to its own run via reply-to correlation', async () => {
    const workA = path.join(tmp, 'workA');
    const workB = path.join(tmp, 'workB');
    mkdirSync(workA);
    mkdirSync(workB);
    writeFileSync(
      path.join(workA, 'clarify-questions.json'),
      JSON.stringify(singleQuestion('RUN-A region?')),
    );
    writeFileSync(
      path.join(workB, 'clarify-questions.json'),
      JSON.stringify(singleQuestion('RUN-B region?')),
    );
    // Skip the shared baseline drain so this case exercises reply routing, not
    // poll-lease contention between a waiting run and a second baseline.
    writeFileSync(path.join(workA, 'clarify.offset'), '1');
    writeFileSync(path.join(workB, 'clarify.offset'), '1');
    const ctxA = makeTestRunContext(tmp, workA, scratch);
    const ctxB = makeTestRunContext(tmp, workB, scratch);
    const env = { ...gateEnv(), AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '30' };

    // Both gates run inside one env scope: process.env is shared, so concurrent
    // withEnvAsync calls would restore each other's vars mid-run.
    const [resultA, resultB] = await withEnvAsync(env, async () => {
      const runA = runClarificationGate(ctxA, path.join(tmp, 'prompt.md'));
      const runB = runClarificationGate(ctxB, path.join(tmp, 'prompt.md'));
      const idA = await waitForSent(stub, 'RUN-A region?');
      const idB = await waitForSent(stub, 'RUN-B region?');
      stub.queueReply(5000, 'answer for A', { replyTo: idA });
      stub.queueReply(5001, 'answer for B', { replyTo: idB });
      return Promise.all([runA, runB]);
    });

    expect(resultA.ok).toBe(true);
    expect(resultB.ok).toBe(true);
    expect(readJsonl(path.join(workA, 'clarify-answers.jsonl'))[0]?.answer).toBe('answer for A');
    expect(readJsonl(path.join(workB, 'clarify-answers.jsonl'))[0]?.answer).toBe('answer for B');
  }, 30_000);

  it('surfaces a persistent 401 as transport exit 8 before the deadline', async () => {
    seedQuestions();
    stub.failNext({ status: 401, errorCode: 401, times: 1000 });
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(
      { ...gateEnv(), AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '30' },
      () => runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(8);
    }
    expect(capture.text()).toContain('Telegram rejected the bot token');
    expect(existsSync(path.join(work, 'clarify.done'))).toBe(false);
  }, 30_000);

  it('surfaces a persistent receive hang as transport exit 8', async () => {
    seedQuestions();
    stub.failNext({ hang: true, times: 1000 });
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(
      { ...gateEnv(), AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '30' },
      () => runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(8);
    }
    expect(capture.text()).toContain('Telegram receive timed out');
  }, 30_000);

  it('records the answer after a transient receive failure recovers', async () => {
    seedQuestions(singleQuestion('Region?'));
    stub.failNext({ status: 500, times: 1 });
    stub.queueReply(7000, 'recovered answer');
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(
      {
        ...gateEnv(),
        AGENT_QUORUM_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS: '30',
        AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '30',
      },
      () => runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(true);
    expect(readJsonl(path.join(work, 'clarify-answers.jsonl'))[0]?.answer).toBe('recovered answer');
  }, 30_000);

  it.each([
    {
      label: 'HTTP-409',
      spec: { status: 409, errorCode: 409, description: 'Conflict', times: 1000 },
    },
    { label: '200 ok:false 409', spec: { errorCode: 409, description: 'Conflict', times: 1000 } },
  ])(
    'names a concurrent consumer on a persistent 409 ($label)',
    async ({ spec }) => {
      seedQuestions();
      stub.failNext(spec);
      const ctx = makeTestRunContext(tmp, work, scratch);

      const result = await withEnvAsync(
        { ...gateEnv(), AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '30' },
        () => runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
      );

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.exitCode).toBe(8);
      }
      const text = capture.text();
      expect(text).toContain('conflict');
      expect(text).toContain('another consumer is polling this bot');
    },
    30_000,
  );

  it('drains pre-gate chatter (including the highest id) without recording it', async () => {
    seedQuestions(singleQuestion('Region?'), { offset: false });
    stub.queueReply(50, 'pre-gate one');
    stub.queueReply(51, 'pre-gate two');
    const ctx = makeTestRunContext(tmp, work, scratch);

    const run = withEnvAsync({ ...gateEnv(), AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '30' }, () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );
    await waitForSent(stub, 'Region?');
    stub.queueReply(100, 'real answer');

    const result = await run;
    expect(result.ok).toBe(true);
    const answers = readJsonl(path.join(work, 'clarify-answers.jsonl'));
    expect(answers).toHaveLength(1);
    expect(answers[0]?.answer).toBe('real answer');
  }, 30_000);

  it('fails fast with exit 8 when the baseline drain cannot reach Telegram, sending nothing', async () => {
    seedQuestions(FIXED_QUESTIONS, { offset: false });
    stub.failNext({ status: 401, errorCode: 401, times: 1000 });
    const ctx = makeTestRunContext(tmp, work, scratch);

    const result = await withEnvAsync(
      { ...gateEnv(), AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '30' },
      () => runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exitCode).toBe(8);
    }
    expect(stub.sent).toHaveLength(0);
    expect(existsSync(path.join(work, 'clarify.done'))).toBe(false);
  }, 30_000);
});

describe('run-level clarify transport mapping', () => {
  let runTmp: string;
  let fake: string;
  let runWork: string;
  let runStub: TelegramStub;
  let runCapture: StderrCapture;

  beforeEach(async () => {
    runTmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-clarifyrun.'));
    fake = path.join(runTmp, 'bin');
    writeFakeBin(fake);
    runWork = path.join(runTmp, 'work');
    mkdirSync(runWork);
    mkdirSync(path.join(runTmp, 'plans'), { recursive: true });
    mkdirSync(path.join(runTmp, 'state'), { recursive: true });
    writeDefaultPlanLoopConfig(path.join(runTmp, 'agent-quorum.json'));
    writeFileSync(path.join(runTmp, 'prompt.md'), 'Build the fixture.\n');
    resetConfigCache();
    runStub = await startTelegramStub();
    runCapture = captureStderr();
  });

  afterEach(async () => {
    runCapture.restore();
    await runStub.close();
    rmSync(runTmp, { recursive: true, force: true });
  });

  it('maps a persistent clarify receive failure to ExitCode.ClarifyTransportFailure', async () => {
    writeFileSync(
      path.join(runWork, 'clarify-questions.json'),
      JSON.stringify(singleQuestion('Region?')),
    );
    runStub.failNext({ status: 401, errorCode: 401, times: 1000 });

    const result = await withEnvAsync(
      {
        PATH: `${fake}:${process.env.PATH ?? ''}`,
        AGENT_QUORUM_CONFIG_FILE: path.join(runTmp, 'agent-quorum.json'),
        AGENT_QUORUM_WORK_DIR: runWork,
        AGENT_QUORUM_PLANS_DIR: path.join(runTmp, 'plans'),
        AGENT_QUORUM_STATE_DIR: path.join(runTmp, 'state'),
        AGENT_QUORUM_RETRY_COUNT: '0',
        AGENT_QUORUM_RESUME: undefined,
        FAKE_CODEX_PROMPT: path.join(runTmp, 'codex.prompt'),
        AGENT_QUORUM_TELEGRAM_BOT_TOKEN: 't',
        AGENT_QUORUM_TELEGRAM_CHAT_ID: '42',
        AGENT_QUORUM_TELEGRAM_API_BASE: runStub.baseUrl,
        AGENT_QUORUM_TELEGRAM_STATE_DIR: path.join(runTmp, 'tg-state'),
        AGENT_QUORUM_CLARIFY: '1',
        AGENT_QUORUM_TELEGRAM_POLL_TIMEOUT: '1',
        AGENT_QUORUM_TELEGRAM_HTTP_TIMEOUT: '1',
        AGENT_QUORUM_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS: '1',
        AGENT_QUORUM_TELEGRAM_RECEIVE_BACKOFF_SECONDS: '1',
        AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS: '30',
      },
      () =>
        runPlanLoop({
          input: path.join(runTmp, 'prompt.md'),
          prompt: true,
          iters: 1,
          effort: 'low',
          fix: false,
          translate: false,
        }),
    );

    expect(result.exitCode).toBe(ExitCode.ClarifyTransportFailure);
    expect(runStub.sent.join('\n')).toContain('FAILED (exit 8)');
  }, 30_000);
});
