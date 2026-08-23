import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  renderTelegramCompletionNotification,
  TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS,
  telegramGetUpdates,
  type TelegramRuntime,
} from '../../src/channels/telegram/index.js';
import { finalProjection } from '../helpers/final-projection.js';

const RUNTIME: TelegramRuntime = {
  botToken: 't',
  chatId: '42',
  apiBase: 'http://127.0.0.1:1',
  httpTimeoutSeconds: 70,
  pollTimeoutSeconds: 50,
  receiveFailureWindowSeconds: 120,
  receiveBackoffSeconds: 2,
  stateDir: '/tmp',
};

function mockFetchJson(status: number, body: unknown): void {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify(body), { status }));
}

function chatMessage(updateId: number, extra: Record<string, unknown> = {}): unknown {
  return {
    update_id: updateId,
    message: { chat: { id: 42 }, text: 'hi', ...extra },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Telegram completion notification rendering', () => {
  it('renders a clean success without an unnecessary reason', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/input.md',
      exitCode: 0,
      final: finalProjection('/tmp/work'),
      reason: 'this should not be included',
      iterations: 2,
      summaryPath: '/tmp/work/summary.md',
    });

    expect(message).toBe(
      [
        'agent-quorum finished: SUCCESS',
        'input: input.md',
        'status: clean',
        'structural: clean',
        'decision: ready',
        'reasons: none',
        'iterations: 2',
        'summary: /tmp/work/summary.md',
      ].join('\n'),
    );
  });

  it('renders a needs-review success with the stable aggregate reason', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/review-plan.md',
      exitCode: 0,
      final: finalProjection('/tmp/work', {
        status: 'needs-review',
        decision: 'unable-to-decide',
        reasonCodes: ['stale-line-reference', 'fix-pass-incomplete'],
      }),
      iterations: 3,
      summaryPath: '/tmp/work/summary.md',
    });

    expect(message).toContain('agent-quorum finished: SUCCESS');
    expect(message).toContain('input: review-plan.md');
    expect(message).toContain('status: needs-review');
    expect(message).toContain('decision: unable-to-decide');
    expect(message).toContain(
      'reasons: Readiness proof: unable-to-decide:stale-line-reference,fix-pass-incomplete',
    );
  });

  it('renders final Judge readiness separately from structural status', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/review-plan.md',
      exitCode: 0,
      final: finalProjection('/tmp/work', {
        status: 'needs-review',
        decision: 'revision-required',
        reasonCodes: ['judge-not-ready'],
        judge: {
          required: true,
          evaluated: true,
          available: true,
          verdict: false,
          rationale: 'final-judge-not-ready',
        },
      }),
      iterations: 2,
    });

    expect(message).toContain('status: needs-review');
    expect(message).toContain('structural: clean');
    expect(message).toContain('decision: revision-required');
    expect(message).toContain('judge: not-ready');
    expect(message).toContain('judge rationale: final-judge-not-ready');
  });

  it('renders final Judge approval on a clean success', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/ready-plan.md',
      exitCode: 0,
      final: finalProjection('/tmp/work', {
        judge: {
          required: true,
          evaluated: true,
          available: true,
          verdict: true,
          rationale: 'final-judge-ready',
        },
      }),
      iterations: 1,
    });

    expect(message).toContain('status: clean');
    expect(message).toContain('structural: clean');
    expect(message).toContain('decision: ready');
    expect(message).toContain('judge: ready');
    expect(message).toContain('judge rationale: final-judge-ready');
  });

  it('does not render an arbitrary Judge rationale from a supplied projection', () => {
    const providerSecret = 'TELEGRAM_JUDGE_RATIONALE_SECRET_90b640';
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/review-plan.md',
      exitCode: 0,
      final: finalProjection('/tmp/work', {
        status: 'needs-review',
        decision: 'unable-to-decide',
        judge: {
          required: true,
          evaluated: true,
          available: true,
          verdict: false,
          rationale: providerSecret,
        },
      }),
    });

    expect(message).toContain('judge rationale: unavailable');
    expect(message).not.toContain(providerSecret);
  });

  it('renders a blocked failure with a stable reason code and summary details', () => {
    const failureSecret = 'TELEGRAM_FAILURE_DETAIL_SECRET_b728f6';
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/broken.md',
      exitCode: 6,
      reason: failureSecret,
      summaryPath: '/tmp/work/summary.md',
      workDir: '/tmp/work',
    });

    expect(message).toBe(
      [
        'agent-quorum finished: FAILED (exit 6)',
        'input: broken.md',
        'reason: run-failed',
        'summary: /tmp/work/summary.md',
      ].join('\n'),
    );
    expect(message).not.toContain(failureSecret);
  });

  it('does not render long multiline failure details', () => {
    const failureDetail = `${'schema validation failed '.repeat(12)}\nwith many details`;
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/schema.md',
      exitCode: 3,
      reason: failureDetail,
      workDir: '/tmp/work',
    });

    expect(message).toContain('reason: run-failed');
    expect(message).not.toContain(failureDetail);
    expect(message).not.toContain('schema validation failed');
  });

  it('uses only the input basename', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/secret/project/task.md',
      exitCode: 0,
      final: finalProjection('/tmp/work'),
      iterations: 0,
    });

    expect(message).toContain('input: task.md');
    expect(message).not.toContain('/tmp/secret/project');
  });
});

describe('telegramGetUpdates transport classification', () => {
  it('classifies a non-2xx 409 as conflict', async () => {
    mockFetchJson(409, {
      ok: false,
      error_code: 409,
      description: 'Conflict: terminated by other getUpdates',
    });
    const result = await telegramGetUpdates(RUNTIME, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('conflict');
      expect(result.failure.errorCode).toBe(409);
      expect(result.failure.description).toContain('Conflict');
    }
  });

  it('classifies an HTTP-200 ok:false error_code 401 as unauthorized', async () => {
    mockFetchJson(200, { ok: false, error_code: 401, description: 'Unauthorized' });
    const result = await telegramGetUpdates(RUNTIME, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('unauthorized');
      expect(result.failure.errorCode).toBe(401);
    }
  });

  it('prefers the body error_code over the HTTP status (500 body 409 → conflict)', async () => {
    mockFetchJson(500, { ok: false, error_code: 409, description: 'proxied conflict' });
    const result = await telegramGetUpdates(RUNTIME, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('conflict');
      expect(result.failure.errorCode).toBe(409);
      expect(result.failure.status).toBe(500);
    }
  });

  it('classifies a bare ok:false envelope without a code', async () => {
    mockFetchJson(200, { ok: false, description: 'something off' });
    const result = await telegramGetUpdates(RUNTIME, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('envelope');
      expect(result.failure.description).toBe('something off');
    }
  });

  it('classifies an abort as a timeout', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'TimeoutError' }),
    );
    const result = await telegramGetUpdates(RUNTIME, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('timeout');
    }
  });

  it('classifies an unparseable 2xx body as parse', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<<not json>>', { status: 200 }));
    const result = await telegramGetUpdates(RUNTIME, 0, 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.failure.kind).toBe('parse');
    }
  });

  it('derives nextOffset from a non-chat update id between chat updates', async () => {
    mockFetchJson(200, {
      ok: true,
      result: [
        chatMessage(10),
        { update_id: 11, message: { chat: { id: 999 }, text: 'other chat' } },
      ],
    });
    const result = await telegramGetUpdates(RUNTIME, 0, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0]?.updateId).toBe(10);
      expect(result.nextOffset).toBe(12);
    }
  });

  it('parses reply_to_message.message_id as a number', async () => {
    mockFetchJson(200, {
      ok: true,
      result: [chatMessage(20, { reply_to_message: { message_id: 7 } })],
    });
    const result = await telegramGetUpdates(RUNTIME, 0, 0);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.updates[0]?.replyToMessageId).toBe(7);
    }
  });

  it('honors an httpTimeoutSeconds override for the HTTP abort', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetchJson(200, { ok: true, result: [] });
    await telegramGetUpdates(RUNTIME, 0, 50, { httpTimeoutSeconds: 3 });
    expect(timeoutSpy).toHaveBeenCalledWith(3000);
  });

  it('defaults the HTTP abort to the long-poll duration plus slack', async () => {
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
    mockFetchJson(200, { ok: true, result: [] });
    await telegramGetUpdates(RUNTIME, 0, 50);
    expect(timeoutSpy).toHaveBeenCalledWith((50 + TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS) * 1000);
  });
});
