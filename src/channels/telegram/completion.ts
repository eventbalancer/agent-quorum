import path from 'node:path';
import { log } from '../../runtime/log.js';
import type { FinalProjection } from '../../types.js';
import { telegramConfigured, type TelegramRuntime } from './config.js';
import { telegramSend } from './send.js';

const FAILURE_REASON = 'run-failed';
const PUBLIC_JUDGE_RATIONALES = new Set([
  'standard-risk-judge-exempt',
  'structural-blocked',
  'assurance-appetite-judge-unavailable',
  'final-judge-proof-unavailable',
  'final-judge-ready',
  'final-judge-not-ready',
  'final-judge-candidate-mutated',
  'final-candidate-mutated-during-system-check',
  'final-candidate-mutated-during-localization',
]);

export interface TelegramCompletionNotification {
  readonly inputPath: string;
  readonly exitCode: number;
  readonly reason?: string;
  readonly iterations?: number;
  readonly summaryPath?: string;
  readonly workDir?: string;
  readonly final?: FinalProjection;
}

function publicJudgeRationale(rationale: string): string {
  return PUBLIC_JUDGE_RATIONALES.has(rationale) ? rationale : 'unavailable';
}

export function renderTelegramCompletionNotification(
  notification: TelegramCompletionNotification,
): string {
  const isSuccess = notification.exitCode === 0;
  const lines = [
    `agent-quorum finished: ${isSuccess ? 'SUCCESS' : `FAILED (exit ${notification.exitCode})`}`,
    `input: ${path.basename(notification.inputPath)}`,
  ];

  if (notification.final !== undefined) {
    const final = notification.final;
    lines.push(`status: ${final.status}`);
    lines.push(`structural: ${final.structuralStatus}`);
    lines.push(`decision: ${final.readiness.decision}`);
    lines.push(`reasons: ${final.reasons.length > 0 ? final.reasons.join(',') : 'none'}`);
    if (final.judge.required) {
      lines.push(
        `judge: ${final.judge.available ? (final.judge.verdict === true ? 'ready' : 'not-ready') : 'unavailable'}`,
      );
      lines.push(`judge rationale: ${publicJudgeRationale(final.judge.rationale)}`);
    }
  }
  if (isSuccess && notification.iterations !== undefined) {
    lines.push(`iterations: ${notification.iterations}`);
  }

  if (!isSuccess && notification.reason !== undefined && notification.reason !== '') {
    lines.push(`reason: ${FAILURE_REASON}`);
  }

  if (notification.summaryPath !== undefined && notification.summaryPath !== '') {
    lines.push(`summary: ${notification.summaryPath}`);
  } else if (!isSuccess && notification.workDir !== undefined && notification.workDir !== '') {
    lines.push(`workdir: ${notification.workDir}`);
  }

  return lines.join('\n');
}

export async function telegramNotifyCompletion(
  runtime: TelegramRuntime,
  notification: TelegramCompletionNotification,
): Promise<void> {
  if (!telegramConfigured(runtime)) {
    return;
  }
  const messageId = await telegramSend(runtime, renderTelegramCompletionNotification(notification));
  if (messageId === undefined) {
    log('WARNING: failed to send Telegram completion notification');
  }
}
