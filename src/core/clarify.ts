import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { err, log } from '../runtime/log.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import { nowUtcStamp } from './artifacts.js';
import { runCreatorClarify } from './creator.js';
import { operatorInterventionsFile } from './interventions.js';
import { schemaValidQuiet } from './schema.js';
import { telegramConfigured, telegramGetUpdates, telegramSend } from './telegram.js';
import type { RunContext } from './run-context.js';

function clarifyQuestionsFile(work: string): string {
  return path.join(work, 'clarify-questions.json');
}
function clarifyAnswersFile(work: string): string {
  return path.join(work, 'clarify-answers.jsonl');
}
function clarifyOffsetFile(work: string): string {
  return path.join(work, 'clarify.offset');
}
export function clarifyDoneFile(work: string): string {
  return path.join(work, 'clarify.done');
}

type GateMode = 'run' | 'skip' | 'error';

export function clarifyGateEnabled(): GateMode {
  const value = process.env.PLAN_LOOP_CLARIFY ?? 'auto';
  switch (value) {
    case '0':
    case 'false':
    case 'off':
    case 'no':
      return 'skip';
    case '1':
    case 'true':
    case 'on':
    case 'yes':
      if (!telegramConfigured()) {
        err(
          `clarification gate requested (PLAN_LOOP_CLARIFY=${value}) but PLAN_LOOP_TELEGRAM_BOT_TOKEN / PLAN_LOOP_TELEGRAM_CHAT_ID are not set`,
        );
        return 'error';
      }
      return 'run';
    case 'auto':
    case '':
      return telegramConfigured() ? 'run' : 'skip';
    default:
      err(`PLAN_LOOP_CLARIFY must be 1, 0, or auto (got '${value}')`);
      return 'error';
  }
}

function clarifyOffset(work: string): number {
  const file = clarifyOffsetFile(work);
  if (!nonEmptyFile(file)) {
    return 0;
  }
  return Number(readFileSync(file, 'utf8'));
}

function clarifySetOffset(work: string, offset: number): void {
  writeFileSync(clarifyOffsetFile(work), String(offset));
}

// Establish a baseline so chatter that predates the gate is never read as an
// answer: drain pending updates once and park the offset past the newest.
async function clarifyInitOffset(work: string): Promise<void> {
  if (nonEmptyFile(clarifyOffsetFile(work))) {
    return;
  }
  let max = 0;
  const updates = (await telegramGetUpdates(0, 0)) ?? [];
  for (const update of updates) {
    if (update.updateId >= max) {
      max = update.updateId + 1;
    }
  }
  clarifySetOffset(work, max);
}

function clarifyRecordIntervention(work: string, question: string, answer: string): void {
  const entry = {
    id: `op-clarify-${randomUUID()}`,
    ts: nowUtcStamp(),
    target: 'all',
    message: `Operator clarification — Q: ${question}\nA: ${answer}`,
  };
  appendFileSync(operatorInterventionsFile(work), `${JSON.stringify(entry)}\n`);
}

type WaitOutcome = { kind: 'answer'; text: string } | { kind: 'cancel' } | { kind: 'deadline' };

interface ClarifyCopy {
  intro(base: string, total: number): string;
  questionLabel(qnum: number, total: number): string;
  whyLabel: string;
  optionsLabel: string;
  replyOptions(optcount: number): string;
  replyFree: string;
  skipAnswer: string;
  cancelled: string;
  timeout(qnum: number): string;
  done(total: number): string;
}

function clarifyCopy(locale: string): ClarifyCopy {
  if (locale.toLowerCase().startsWith('ru')) {
    return {
      intro: (base, total) =>
        `🧭 Перед созданием плана для "${base}" нужно уточнить ${total} пункт(ов). Я задам вопросы по одному — ответьте на каждый. Можно ответить номером варианта или своим текстом. /skip — доверить решение агенту, /cancel — отменить запуск.`,
      questionLabel: (qnum, total) => `❓ Вопрос ${qnum}/${total}`,
      whyLabel: 'ℹ️ Почему это важно',
      optionsLabel: 'Варианты',
      replyOptions: (optcount) =>
        `Ответьте номером (1–${optcount}) или своим текстом. /skip — доверить решение агенту, /cancel — отменить.`,
      replyFree: 'Ответьте своим текстом. /skip — доверить решение агенту, /cancel — отменить.',
      skipAnswer: '(оператор пропустил вопрос — действуй по своему усмотрению)',
      cancelled: '🛑 Отменено — plan-loop останавливается.',
      timeout: (qnum) =>
        `⌛ Не дождался ответа на вопрос ${qnum} — plan-loop останавливается. Перезапустите тот же input, чтобы продолжить.`,
      done: (total) => `✅ Готово — получены все ответы (${total}). Создаю план.`,
    };
  }
  return {
    intro: (base, total) =>
      `🧭 Before creating a plan for "${base}", I need to clarify ${total} point(s). I'll ask them one by one — reply to each. You can answer with an option number or your own text. /skip — leave it to my judgement, /cancel — cancel the run.`,
    questionLabel: (qnum, total) => `❓ Question ${qnum}/${total}`,
    whyLabel: 'ℹ️ Why it matters',
    optionsLabel: 'Options',
    replyOptions: (optcount) =>
      `Reply with a number (1–${optcount}) or your own text. /skip — my judgement, /cancel — cancel.`,
    replyFree: 'Reply with your own text. /skip — my judgement, /cancel — cancel.',
    skipAnswer: '(operator skipped — use your best judgement)',
    cancelled: '🛑 Cancelled — plan-loop is stopping.',
    timeout: (qnum) =>
      `⌛ Timed out waiting for question ${qnum} — plan-loop is stopping. Re-run the same input to resume.`,
    done: (total) => `✅ Done — received all ${total} answers. Creating the plan.`,
  };
}

async function clarifyWaitReply(
  work: string,
  deadlineEpoch: number,
  poll: number,
  skipAnswer: string,
): Promise<WaitOutcome> {
  for (;;) {
    const now = Math.floor(Date.now() / 1000);
    if (now >= deadlineEpoch) {
      return { kind: 'deadline' };
    }
    const updates = (await telegramGetUpdates(clarifyOffset(work), poll)) ?? [];
    for (const update of updates) {
      clarifySetOffset(work, update.updateId + 1);
      if (update.text === '/cancel') {
        return { kind: 'cancel' };
      }
      if (update.text === '/skip') {
        return { kind: 'answer', text: skipAnswer };
      }
      if (update.text === '') {
        continue;
      }
      return { kind: 'answer', text: update.text };
    }
  }
}

function readJsonl(file: string): JsonObject[] {
  if (!existsSync(file)) {
    return [];
  }
  const entries: JsonObject[] = [];
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as JsonValue;
      if (isJsonObject(parsed)) {
        entries.push(parsed);
      }
    } catch {
      return [];
    }
  }
  return entries;
}

function jqText(value: JsonValue | undefined): string {
  if (value === null || value === undefined) {
    return 'null';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

// false return → caller exits 7
export async function runClarificationGate(ctx: RunContext, promptFile: string): Promise<boolean> {
  const work = ctx.work;
  const qfile = clarifyQuestionsFile(work);
  const afile = clarifyAnswersFile(work);

  if (existsSync(clarifyDoneFile(work))) {
    log('clarification gate: already complete');
    return true;
  }

  const mode = clarifyGateEnabled();
  if (mode === 'error') {
    return false;
  }
  if (mode === 'skip') {
    log(
      'clarification gate: disabled (set PLAN_LOOP_TELEGRAM_BOT_TOKEN + PLAN_LOOP_TELEGRAM_CHAT_ID and PLAN_LOOP_CLARIFY=1 to enable)',
    );
    return true;
  }

  if (!(nonEmptyFile(qfile) && schemaValidQuiet(qfile, ctx.skills.clarifySchema))) {
    log(
      `clarification gate: generating questions (${ctx.provider.matrix.creator.runner} ${ctx.provider.matrix.creator.model})`,
    );
    const status = await runCreatorClarify(ctx, promptFile, qfile);
    if (status !== 0) {
      err('clarification gate: question generation failed');
      return false;
    }
  }

  const questionsDoc = JSON.parse(readFileSync(qfile, 'utf8')) as JsonValue;
  const questions =
    isJsonObject(questionsDoc) && Array.isArray(questionsDoc.questions)
      ? questionsDoc.questions
      : [];
  const total = questions.length;
  if (total === 0) {
    log('clarification gate: creator raised no blocking questions');
    writeFileSync(clarifyDoneFile(work), '');
    return true;
  }

  if (!existsSync(afile)) {
    writeFileSync(afile, '');
  }
  const answered = readJsonl(afile).length;
  log(
    `clarification gate: ${total} question(s), ${answered} already answered — waiting via Telegram`,
  );

  const poll = Number(process.env.PLAN_LOOP_TELEGRAM_POLL_TIMEOUT ?? 50);
  const deadline = Number(process.env.PLAN_LOOP_CLARIFY_DEADLINE_SECONDS ?? 86400);
  const deadlineEpoch = Math.floor(Date.now() / 1000) + deadline;
  const copy = clarifyCopy(ctx.settings.locale);

  await clarifyInitOffset(work);

  if (answered === 0) {
    const base = path.basename(work).replace(/^loop-/, '');
    const intro = copy.intro(base, total);
    if ((await telegramSend(intro)) === undefined) {
      err('clarification gate: failed to reach Telegram (check token/chat_id/network)');
      return false;
    }
  }

  for (let idx = 0; idx < total; idx += 1) {
    const entry = isJsonObject(questions[idx]) ? (questions[idx] as JsonObject) : {};
    const id = jqText(entry.id);
    const alreadyAnswered = readJsonl(afile).some((answer) => answer.id === id);
    if (alreadyAnswered) {
      continue;
    }
    const question = jqText(entry.question);
    const why = jqText(entry.why);
    const options = Array.isArray(entry.options) ? entry.options : [];
    const optcount = options.length;

    const qnum = idx + 1;
    let msg = `${copy.questionLabel(qnum, total)}: ${question}`;
    if (why !== '' && why !== 'null') {
      msg += `\n\n${copy.whyLabel}: ${why}`;
    }
    if (optcount > 0) {
      const optsList = options.map((option, key) => `${key + 1}. ${jqText(option)}`).join('\n');
      msg += `\n\n${copy.optionsLabel}:\n${optsList}\n\n${copy.replyOptions(optcount)}`;
    } else {
      msg += `\n\n${copy.replyFree}`;
    }
    if ((await telegramSend(msg)) === undefined) {
      err(`clarification gate: failed to send Q${qnum} to Telegram`);
      return false;
    }
    log(`clarification gate: asked Q${qnum}/${total}, waiting for reply`);

    const outcome = await clarifyWaitReply(work, deadlineEpoch, poll, copy.skipAnswer);
    if (outcome.kind === 'cancel') {
      err('clarification gate: operator sent /cancel — aborting run');
      await telegramSend(copy.cancelled);
      return false;
    }
    if (outcome.kind === 'deadline') {
      err(`clarification gate: timed out after ${deadline}s waiting for Q${qnum}`);
      await telegramSend(copy.timeout(qnum));
      return false;
    }

    let ans = outcome.text;
    if (/^[0-9]+$/.test(ans) && optcount > 0) {
      const n = Number(ans);
      if (n >= 1 && n <= optcount) {
        ans = jqText(options[n - 1]);
      }
    }

    appendFileSync(afile, `${JSON.stringify({ id, question, answer: ans, ts: nowUtcStamp() })}\n`);
    log(`clarification gate: recorded answer to Q${qnum}/${total}`);
  }

  const answers = readJsonl(afile);
  for (const answer of answers) {
    clarifyRecordIntervention(work, jqText(answer.question), jqText(answer.answer));
  }

  await telegramSend(copy.done(total));
  writeFileSync(clarifyDoneFile(work), '');
  log(
    `clarification gate: complete — ${answers.length} answer(s) folded into operator interventions`,
  );
  return true;
}
