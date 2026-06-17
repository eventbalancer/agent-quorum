import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { nonEmptyFile } from '../../runtime/files.js';
import { err, log } from '../../runtime/log.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { nowUtcStamp } from '../../core/artifacts.js';
import { runCreatorClarify } from './creator.js';
import { operatorInterventionsFile } from './interventions.js';
import { schemaValidQuiet } from '../../core/schema.js';
import {
  telegramConfigured,
  telegramSend,
  type TelegramFailure,
  type TelegramRuntime,
} from '../../channels/telegram/index.js';
import {
  isPeerHeldResult,
  isPollFailure,
  openClarifyBroker,
  type ClarifyBroker,
} from './clarify-broker.js';
import { ExitCode } from '../../exit-codes.js';
import type { RunContext } from '../../core/run-context.js';

const MAX_RECEIVE_BACKOFF_SECONDS = 30;

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

export function clarifyGateEnabled(value: string, runtime: TelegramRuntime): GateMode {
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
      if (!telegramConfigured(runtime)) {
        err(
          `clarification gate requested (clarify=${value}) but Telegram bot token / chat id are not configured`,
        );
        return 'error';
      }
      return 'run';
    case 'auto':
    case '':
      return telegramConfigured(runtime) ? 'run' : 'skip';
    default:
      err(`clarify must be 1, 0, or auto (got '${value}')`);
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

function clarifyRecordIntervention(work: string, question: string, answer: string): void {
  const entry = {
    id: `op-clarify-${randomUUID()}`,
    ts: nowUtcStamp(),
    target: 'all',
    message: `Operator clarification — Q: ${question}\nA: ${answer}`,
  };
  appendFileSync(operatorInterventionsFile(work), `${JSON.stringify(entry)}\n`);
}

type WaitOutcome =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'deadline' }
  | { readonly kind: 'failure'; readonly failure: TelegramFailure };

export type ClarifyGateOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly exitCode: ExitCode.ClarifyCancelled | ExitCode.ClarifyTransportFailure;
      readonly reason: string;
    };

interface ClarifyCopy {
  readonly intro: (base: string, total: number) => string;
  readonly questionLabel: (qnum: number, total: number) => string;
  readonly whyLabel: string;
  readonly optionsLabel: string;
  readonly replyOptions: (optcount: number) => string;
  readonly replyFree: string;
  readonly skipAnswer: string;
  readonly cancelled: string;
  readonly timeout: (qnum: number) => string;
  readonly done: (total: number) => string;
  readonly concurrencyNotice: string;
  readonly transportFailure: string;
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
      cancelled: '🛑 Отменено — agent-quorum останавливается.',
      timeout: (qnum) =>
        `⌛ Не дождался ответа на вопрос ${qnum} — agent-quorum останавливается. Перезапустите тот же input, чтобы продолжить.`,
      done: (total) => `✅ Готово — получены все ответы (${total}). Создаю план.`,
      concurrencyNotice:
        '⚠️ Этот чат сейчас используют несколько запусков agent-quorum. Отвечайте прямо на сообщение с вопросом (свайп или долгое нажатие → «Ответить»), чтобы ответ попал в нужный запуск.',
      transportFailure:
        '🚫 Потеряна связь с Telegram во время ожидания ответов — agent-quorum останавливается. Проверьте токен бота и что getUpdates не опрашивает кто-то ещё, затем перезапустите.',
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
    cancelled: '🛑 Cancelled — agent-quorum is stopping.',
    timeout: (qnum) =>
      `⌛ Timed out waiting for question ${qnum} — agent-quorum is stopping. Re-run the same input to resume.`,
    done: (total) => `✅ Done — received all ${total} answers. Creating the plan.`,
    concurrencyNotice:
      '⚠️ Multiple agent-quorum runs are using this chat. Reply directly to a question message (swipe or long-press → Reply) so your answer reaches the right run.',
    transportFailure:
      '🚫 Lost the Telegram connection while waiting for replies — agent-quorum is stopping. Check the bot token and that no other consumer is polling getUpdates, then re-run.',
  };
}

function interpretReply(text: string, skipAnswer: string): WaitOutcome | undefined {
  if (text === '/cancel') {
    return { kind: 'cancel' };
  }
  if (text === '/skip') {
    return { kind: 'answer', text: skipAnswer };
  }
  if (text === '') {
    return undefined;
  }
  return { kind: 'answer', text };
}

function describeTransportFailure(failure: TelegramFailure): string {
  const detail = [
    failure.status !== undefined ? `status ${failure.status}` : undefined,
    failure.errorCode !== undefined ? `error_code ${failure.errorCode}` : undefined,
    failure.description,
  ]
    .filter((part): part is string => part !== undefined && part !== '')
    .join(', ');
  const suffix = detail === '' ? '' : `: ${detail}`;
  switch (failure.kind) {
    case 'conflict': {
      return `Telegram getUpdates conflict — another consumer is polling this bot (a second run, a webhook, or another tool)${suffix}`;
    }
    case 'unauthorized': {
      return `Telegram rejected the bot token${suffix}`;
    }
    case 'timeout': {
      return `Telegram receive timed out${suffix}`;
    }
    case 'network': {
      return `Telegram network failure${suffix}`;
    }
    case 'http': {
      return `Telegram HTTP error${suffix}`;
    }
    case 'envelope': {
      return `Telegram returned an error envelope${suffix}`;
    }
    case 'parse': {
      return `Telegram returned an unparseable response${suffix}`;
    }
    default: {
      failure.kind satisfies never;
      return `Telegram transport failure${suffix}`;
    }
  }
}

interface ClarifyWaitParams {
  readonly broker: ClarifyBroker;
  readonly work: string;
  readonly awaitedMessageId: number | undefined;
  readonly deadlineEpoch: number;
  readonly poll: number;
  readonly skipAnswer: string;
  readonly failureWindowMs: number;
  readonly backoffSeconds: number;
  readonly maybeNotifyConcurrency: () => Promise<void>;
}

async function clarifyWaitReply(params: ClarifyWaitParams): Promise<WaitOutcome> {
  const { broker, work, awaitedMessageId, deadlineEpoch, poll, skipAnswer } = params;
  let backoff = params.backoffSeconds;
  for (;;) {
    if (Math.floor(Date.now() / 1000) >= deadlineEpoch) {
      return { kind: 'deadline' };
    }
    const cursor = clarifyOffset(work);
    broker.refresh(cursor);
    await params.maybeNotifyConcurrency();

    const pollResult = await broker.tryPoll(poll);
    if (isPeerHeldResult(pollResult)) {
      await broker.idle();
    } else if (isPollFailure(pollResult)) {
      await sleep(backoff * 1000);
      backoff = Math.min(backoff * 2, MAX_RECEIVE_BACKOFF_SECONDS);
    } else {
      backoff = params.backoffSeconds;
    }

    const health = broker.readHealth();
    if (health.failing && health.sinceMs >= params.failureWindowMs) {
      return { kind: 'failure', failure: health.lastFailure ?? { kind: 'network' } };
    }

    for (const entry of broker.readJournalSince(cursor)) {
      clarifySetOffset(work, entry.updateId + 1);
      if (awaitedMessageId !== undefined && entry.replyToMessageId === awaitedMessageId) {
        const outcome = interpretReply(entry.text, skipAnswer);
        if (outcome !== undefined) {
          return outcome;
        }
        continue;
      }
      if (entry.replyToMessageId === undefined) {
        if (broker.liveSessionCount() === 1 && broker.claimUntargeted(entry.updateId)) {
          const outcome = interpretReply(entry.text, skipAnswer);
          if (outcome !== undefined) {
            return outcome;
          }
        }
        continue;
      }
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

interface ClarifyQuestionContent {
  readonly id: string;
  readonly question: string;
  readonly why: string;
  readonly options: readonly JsonValue[];
}

interface RenderClarifyQuestionParams {
  readonly copy: ClarifyCopy;
  readonly qnum: number;
  readonly total: number;
  readonly question: string;
  readonly why: string;
  readonly options: readonly JsonValue[];
}

function clarifyQuestionContent(value: JsonValue | undefined): ClarifyQuestionContent {
  const entry = isJsonObject(value) ? value : {};
  return {
    id: jqText(entry.id),
    question: jqText(entry.question),
    why: jqText(entry.why),
    options: Array.isArray(entry.options) ? entry.options : [],
  };
}

function renderClarifyQuestion({
  copy,
  qnum,
  total,
  question,
  why,
  options,
}: RenderClarifyQuestionParams): string {
  let message = `${copy.questionLabel(qnum, total)}: ${question}`;
  if (why !== '' && why !== 'null') {
    message += `\n\n${copy.whyLabel}: ${why}`;
  }
  if (options.length === 0) {
    return `${message}\n\n${copy.replyFree}`;
  }
  const optionsList = options.map((option, key) => `${key + 1}. ${jqText(option)}`).join('\n');
  return `${message}\n\n${copy.optionsLabel}:\n${optionsList}\n\n${copy.replyOptions(options.length)}`;
}

function answerText(reply: string, options: readonly JsonValue[]): string {
  if (!/^[0-9]+$/.test(reply) || options.length === 0) {
    return reply;
  }
  const optionIndex = Number(reply) - 1;
  const selected = options[optionIndex];
  return selected === undefined ? reply : jqText(selected);
}

export async function runClarificationGate(
  ctx: RunContext,
  promptFile: string,
): Promise<ClarifyGateOutcome> {
  const work = ctx.work;
  const qfile = clarifyQuestionsFile(work);
  const afile = clarifyAnswersFile(work);

  if (existsSync(clarifyDoneFile(work))) {
    log('clarification gate: already complete');
    return { ok: true };
  }

  const runtime = ctx.config.telegram;
  const mode = clarifyGateEnabled(runtime.clarify, runtime);
  if (mode === 'error') {
    return {
      ok: false,
      exitCode: ExitCode.ClarifyCancelled,
      reason: 'clarification gate misconfigured',
    };
  }
  if (mode === 'skip') {
    log(
      'clarification gate: disabled (set AGENT_QUORUM_TELEGRAM_BOT_TOKEN + AGENT_QUORUM_TELEGRAM_CHAT_ID and AGENT_QUORUM_CLARIFY=1 to enable)',
    );
    return { ok: true };
  }

  if (!(nonEmptyFile(qfile) && schemaValidQuiet(qfile, ctx.skills.clarifySchema))) {
    log(
      `clarification gate: generating questions (${ctx.provider.matrix.creator.runner} ${ctx.provider.matrix.creator.model})`,
    );
    const status = await runCreatorClarify(ctx, promptFile, qfile);
    if (status !== 0) {
      err('clarification gate: question generation failed');
      return {
        ok: false,
        exitCode: ExitCode.ClarifyCancelled,
        reason: 'clarification question generation failed',
      };
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
    return { ok: true };
  }

  if (!existsSync(afile)) {
    writeFileSync(afile, '');
  }
  const answered = readJsonl(afile).length;
  log(
    `clarification gate: ${total} question(s), ${answered} already answered — waiting via Telegram`,
  );

  const poll = runtime.pollTimeoutSeconds;
  const deadline = runtime.clarifyDeadlineSeconds;
  const deadlineEpoch = Math.floor(Date.now() / 1000) + deadline;
  const failureWindowMs = runtime.receiveFailureWindowSeconds * 1000;
  const backoffSeconds = runtime.receiveBackoffSeconds;
  const copy = clarifyCopy(ctx.settings.locale);

  let broker: ClarifyBroker;
  try {
    broker = openClarifyBroker(runtime);
  } catch (error) {
    const reason = `Telegram coordination dir unavailable: ${error instanceof Error ? error.message : 'unknown error'}`;
    err(`clarification gate: ${reason}`);
    return { ok: false, exitCode: ExitCode.ClarifyTransportFailure, reason };
  }

  try {
    if (!nonEmptyFile(clarifyOffsetFile(work))) {
      const base = await broker.ensureBaseline();
      if (!base.ok) {
        const reason = describeTransportFailure(base.failure);
        err(`clarification gate: ${reason} (during baseline)`);
        return { ok: false, exitCode: ExitCode.ClarifyTransportFailure, reason };
      }
      clarifySetOffset(work, base.cursor);
    }

    let concurrencyNoticeSent = false;
    const maybeNotifyConcurrency = async (): Promise<void> => {
      if (concurrencyNoticeSent || broker.liveSessionCount() <= 1) {
        return;
      }
      concurrencyNoticeSent = true;
      await telegramSend(runtime, copy.concurrencyNotice);
    };

    await maybeNotifyConcurrency();

    if (answered === 0) {
      const base = path.basename(work).replace(/^loop-/, '');
      const intro = copy.intro(base, total);
      if ((await telegramSend(runtime, intro)) === undefined) {
        err('clarification gate: failed to reach Telegram (check token/chat_id/network)');
        return {
          ok: false,
          exitCode: ExitCode.ClarifyCancelled,
          reason: 'failed to reach Telegram',
        };
      }
    }

    for (let idx = 0; idx < total; idx += 1) {
      const { id, question, why, options } = clarifyQuestionContent(questions[idx]);
      const alreadyAnswered = readJsonl(afile).some((answer) => answer.id === id);
      if (alreadyAnswered) {
        continue;
      }

      const qnum = idx + 1;
      const msg = renderClarifyQuestion({ copy, qnum, total, question, why, options });
      const sent = await telegramSend(runtime, msg);
      if (sent === undefined) {
        err(`clarification gate: failed to send Q${qnum} to Telegram`);
        return {
          ok: false,
          exitCode: ExitCode.ClarifyCancelled,
          reason: `failed to send Q${qnum} to Telegram`,
        };
      }
      const sentId = Number(sent);
      const awaitedMessageId = Number.isInteger(sentId) && sentId > 0 ? sentId : undefined;
      log(`clarification gate: asked Q${qnum}/${total}, waiting for reply`);

      const outcome = await clarifyWaitReply({
        broker,
        work,
        awaitedMessageId,
        deadlineEpoch,
        poll,
        skipAnswer: copy.skipAnswer,
        failureWindowMs,
        backoffSeconds,
        maybeNotifyConcurrency,
      });
      if (outcome.kind === 'cancel') {
        err('clarification gate: operator sent /cancel — aborting run');
        await telegramSend(runtime, copy.cancelled);
        return { ok: false, exitCode: ExitCode.ClarifyCancelled, reason: 'operator sent /cancel' };
      }
      if (outcome.kind === 'deadline') {
        err(`clarification gate: timed out after ${deadline}s waiting for Q${qnum}`);
        await telegramSend(runtime, copy.timeout(qnum));
        return {
          ok: false,
          exitCode: ExitCode.ClarifyCancelled,
          reason: `timed out after ${deadline}s waiting for Q${qnum}`,
        };
      }
      if (outcome.kind === 'failure') {
        const reason = describeTransportFailure(outcome.failure);
        err(`clarification gate: ${reason}`);
        await telegramSend(runtime, copy.transportFailure);
        return { ok: false, exitCode: ExitCode.ClarifyTransportFailure, reason };
      }

      const ans = answerText(outcome.text, options);

      appendFileSync(
        afile,
        `${JSON.stringify({ id, question, answer: ans, ts: nowUtcStamp() })}\n`,
      );
      log(`clarification gate: recorded answer to Q${qnum}/${total}`);
    }

    const answers = readJsonl(afile);
    for (const answer of answers) {
      clarifyRecordIntervention(work, jqText(answer.question), jqText(answer.answer));
    }

    await telegramSend(runtime, copy.done(total));
    writeFileSync(clarifyDoneFile(work), '');
    log(
      `clarification gate: complete — ${answers.length} answer(s) folded into operator interventions`,
    );
    return { ok: true };
  } finally {
    broker.close();
  }
}
