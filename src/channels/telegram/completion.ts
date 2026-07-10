import path from 'node:path';
import { log } from '../../runtime/log.js';
import { readinessLabel, type FinalReadiness, type RunFinalStatus } from '../../types.js';
import { telegramConfigured, type TelegramRuntime } from './config.js';
import { telegramSend } from './send.js';

const COMPLETION_REASON_MAX_LENGTH = 180;

export interface TelegramCompletionNotification {
  readonly inputPath: string;
  readonly exitCode: number;
  readonly status?: string;
  readonly reason?: string;
  readonly iterations?: number;
  readonly summaryPath?: string;
  readonly workDir?: string;
  readonly structuralStatus?: RunFinalStatus;
  readonly readiness?: FinalReadiness;
}

function compactCompletionReason(reason: string | undefined): string | undefined {
  const compact = reason?.replace(/\s+/g, ' ').trim();
  if (compact === undefined || compact === '') {
    return undefined;
  }
  if (compact.length <= COMPLETION_REASON_MAX_LENGTH) {
    return compact;
  }
  return `${compact.slice(0, COMPLETION_REASON_MAX_LENGTH - 3).trimEnd()}...`;
}

export function renderTelegramCompletionNotification(
  notification: TelegramCompletionNotification,
): string {
  const isSuccess = notification.exitCode === 0;
  const lines = [
    `agent-quorum finished: ${isSuccess ? 'SUCCESS' : `FAILED (exit ${notification.exitCode})`}`,
    `input: ${path.basename(notification.inputPath)}`,
  ];

  if (notification.status !== undefined && notification.status !== '') {
    lines.push(`status: ${notification.status}`);
  }
  if (notification.readiness !== undefined) {
    if (notification.structuralStatus !== undefined) {
      lines.push(`structural: ${notification.structuralStatus}`);
    }
    const readiness = notification.readiness;
    lines.push(`readiness: ${readinessLabel(readiness.ready)}`);
    lines.push(`readiness rationale: ${readiness.rationale}`);
  }
  if (isSuccess && notification.iterations !== undefined) {
    lines.push(`iterations: ${notification.iterations}`);
  }

  const reason = compactCompletionReason(notification.reason);
  if ((!isSuccess || notification.status === 'needs-review') && reason !== undefined) {
    lines.push(`reason: ${reason}`);
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
