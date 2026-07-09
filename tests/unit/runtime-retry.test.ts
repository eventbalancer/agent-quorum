import { describe, expect, it } from 'vitest';
import { runWithRetries } from '../../src/runtime/retry.js';

describe('runWithRetries', () => {
  it('returns 0 immediately on success', async () => {
    let calls = 0;
    const status = await runWithRetries('probe', { retryCount: 3, retryDelaySeconds: 0 }, () => {
      calls += 1;
      return { status: 0, retryable: true };
    });
    expect(status).toBe(0);
    expect(calls).toBe(1);
  });

  it('retries up to retryCount then returns the last status', async () => {
    let calls = 0;
    const status = await runWithRetries('probe', { retryCount: 2, retryDelaySeconds: 0 }, () => {
      calls += 1;
      return { status: 7, retryable: true };
    });
    expect(status).toBe(7);
    expect(calls).toBe(3);
  });

  it('recovers when a retry succeeds', async () => {
    let calls = 0;
    const status = await runWithRetries('probe', { retryCount: 2, retryDelaySeconds: 0 }, () => {
      calls += 1;
      return { status: calls < 2 ? 1 : 0, retryable: true };
    });
    expect(status).toBe(0);
    expect(calls).toBe(2);
  });

  it('never retries with retryCount=0', async () => {
    let calls = 0;
    const status = await runWithRetries('probe', { retryCount: 0, retryDelaySeconds: 0 }, () => {
      calls += 1;
      return { status: 9, retryable: true };
    });
    expect(status).toBe(9);
    expect(calls).toBe(1);
  });

  it('returns a non-retryable status without another attempt', async () => {
    let calls = 0;
    const status = await runWithRetries('probe', { retryCount: 3, retryDelaySeconds: 0 }, () => {
      calls += 1;
      return { status: 8, retryable: false };
    });
    expect(status).toBe(8);
    expect(calls).toBe(1);
  });
});
