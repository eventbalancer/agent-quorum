import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clarifyGateEnabled, runClarificationGate } from '../../src/core/clarify.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { captureStderr, withEnv, withEnvAsync, type StderrCapture } from '../helpers/harness.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import { startTelegramStub, type TelegramStub } from '../helpers/telegram-stub.js';

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

function seedQuestions(questions: unknown = FIXED_QUESTIONS): void {
  writeFileSync(
    path.join(work, 'clarify-questions.json'),
    `${JSON.stringify(questions, null, 2)}\n`,
  );
  writeFileSync(path.join(work, 'clarify.offset'), '0');
}

function gateEnv(): Record<string, string> {
  return {
    PLAN_LOOP_TELEGRAM_BOT_TOKEN: 't',
    PLAN_LOOP_TELEGRAM_CHAT_ID: '42',
    PLAN_LOOP_TELEGRAM_API_BASE: stub.baseUrl,
    PLAN_LOOP_TELEGRAM_POLL_TIMEOUT: '1',
    PLAN_LOOP_CLARIFY_DEADLINE_SECONDS: '3',
    PLAN_LOOP_CLARIFY: undefined as unknown as string,
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
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-clarifytest.'));
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
  it('honors PLAN_LOOP_CLARIFY and credentials', () => {
    expect(
      withEnv(
        {
          PLAN_LOOP_TELEGRAM_BOT_TOKEN: 't',
          PLAN_LOOP_TELEGRAM_CHAT_ID: '42',
          PLAN_LOOP_CLARIFY: 'auto',
        },
        () => clarifyGateEnabled(),
      ),
    ).toBe('run');
    expect(
      withEnv(
        {
          PLAN_LOOP_TELEGRAM_BOT_TOKEN: 't',
          PLAN_LOOP_TELEGRAM_CHAT_ID: '42',
          PLAN_LOOP_CLARIFY: '0',
        },
        () => clarifyGateEnabled(),
      ),
    ).toBe('skip');
    expect(
      withEnv(
        {
          PLAN_LOOP_TELEGRAM_BOT_TOKEN: undefined,
          PLAN_LOOP_TELEGRAM_CHAT_ID: undefined,
          PLAN_LOOP_CLARIFY: 'auto',
        },
        () => clarifyGateEnabled(),
      ),
    ).toBe('skip');
    expect(
      withEnv(
        {
          PLAN_LOOP_TELEGRAM_BOT_TOKEN: undefined,
          PLAN_LOOP_TELEGRAM_CHAT_ID: undefined,
          PLAN_LOOP_CLARIFY: '1',
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

    const ok = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(ok).toBe(true);
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

    const ok = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(ok).toBe(true);
    const answers = readJsonl(path.join(work, 'clarify-answers.jsonl'));
    expect(answers[0]?.answer).toBe('IO and RU');
    expect(answers[1]?.answer).toBe('Hard cutover');
    expect(readFileSync(path.join(work, 'operator-interventions.jsonl'), 'utf8')).toContain(
      'IO and RU',
    );
  });

  it('is a no-op when the creator raises no blocking questions', async () => {
    seedQuestions({ questions: [] });
    const ctx = makeTestRunContext(tmp, work, scratch);

    const ok = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(ok).toBe(true);
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

    const ok = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(ok).toBe(true);
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

    const ok = await withEnvAsync(gateEnv(), () =>
      runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(ok).toBe(false);
    expect(existsSync(path.join(work, 'clarify.done'))).toBe(false);
    expect(capture.text()).toContain('operator sent /cancel — aborting run');
  });

  it('deadline expiry aborts the gate', async () => {
    seedQuestions();
    const ctx = makeTestRunContext(tmp, work, scratch);

    const ok = await withEnvAsync(
      {
        ...gateEnv(),
        PLAN_LOOP_CLARIFY_DEADLINE_SECONDS: '1',
        PLAN_LOOP_TELEGRAM_POLL_TIMEOUT: '1',
      },
      () => runClarificationGate(ctx, path.join(tmp, 'prompt.md')),
    );

    expect(ok).toBe(false);
    expect(capture.text()).toContain('timed out after 1s waiting for Q1');
    expect(existsSync(path.join(work, 'clarify.done'))).toBe(false);
  }, 30_000);
});
