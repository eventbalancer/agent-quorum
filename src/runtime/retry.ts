import { setTimeout as sleep } from 'node:timers/promises';
import { err, log } from './log.js';

export interface RetryPolicy {
  retryCount: number;
  retryDelaySeconds: number;
}

type MaybePromise<T> = T | Promise<T>;

export interface RetryAttemptResult {
  readonly status: number;
  readonly retryable: boolean;
}

export async function runWithRetries(
  label: string,
  policy: RetryPolicy,
  attempt: () => MaybePromise<RetryAttemptResult>,
): Promise<number> {
  let retry = 0;
  for (;;) {
    const { status, retryable } = await Promise.resolve(attempt());
    if (status === 0) {
      return 0;
    }
    if (!retryable) {
      return status;
    }
    if (retry >= policy.retryCount) {
      err(`${label} failed after ${retry + 1} attempt(s)`);
      return status;
    }
    retry += 1;
    log(
      `WARNING: ${label} failed; retry ${retry}/${policy.retryCount} in ${policy.retryDelaySeconds}s`,
    );
    await sleep(policy.retryDelaySeconds * 1000);
  }
}
