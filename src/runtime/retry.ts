import {
  assertExecutionAllowed,
  controlledDelay,
  type ExecutionControl,
} from './execution-control.js';
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
  control?: ExecutionControl,
): Promise<number> {
  if (
    !Number.isSafeInteger(policy.retryCount) ||
    policy.retryCount < 0 ||
    !Number.isFinite(policy.retryDelaySeconds) ||
    policy.retryDelaySeconds < 0
  ) {
    throw new TypeError('retry limits must be finite and non-negative');
  }
  let retry = 0;
  for (;;) {
    assertExecutionAllowed(control);
    const { status, retryable } = await Promise.resolve(attempt());
    assertExecutionAllowed(control);
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
    await controlledDelay(policy.retryDelaySeconds * 1000, control);
  }
}
