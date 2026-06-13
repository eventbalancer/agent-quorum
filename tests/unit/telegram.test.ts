import { describe, expect, it } from 'vitest';
import { renderTelegramCompletionNotification } from '../../src/core/telegram.js';

describe('Telegram completion notification rendering', () => {
  it('renders a clean success without an unnecessary reason', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/input.md',
      exitCode: 0,
      status: 'clean',
      reason: 'this should not be included',
      iterations: 2,
      summaryPath: '/tmp/work/summary.md',
    });

    expect(message).toBe(
      [
        'agent-quorum finished: SUCCESS',
        'input: input.md',
        'status: clean',
        'iterations: 2',
        'summary: /tmp/work/summary.md',
      ].join('\n'),
    );
  });

  it('renders a needs-review success with a compact reason', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/review-plan.md',
      exitCode: 0,
      status: 'needs-review',
      reason: '2 stale line reference(s)\nremain after fix-pass',
      iterations: 3,
      summaryPath: '/tmp/work/summary.md',
    });

    expect(message).toContain('agent-quorum finished: SUCCESS');
    expect(message).toContain('input: review-plan.md');
    expect(message).toContain('status: needs-review');
    expect(message).toContain('reason: 2 stale line reference(s) remain after fix-pass');
  });

  it('renders a blocked failure with summary details', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/broken.md',
      exitCode: 6,
      status: 'blocked',
      reason: 'plan shape broken (title=0 missing_sections=7 impact_graph_mermaid=0)',
      summaryPath: '/tmp/work/summary.md',
      workDir: '/tmp/work',
    });

    expect(message).toBe(
      [
        'agent-quorum finished: FAILED (exit 6)',
        'input: broken.md',
        'status: blocked',
        'reason: plan shape broken (title=0 missing_sections=7 impact_graph_mermaid=0)',
        'summary: /tmp/work/summary.md',
      ].join('\n'),
    );
  });

  it('compacts long multiline failure reasons', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/private/schema.md',
      exitCode: 3,
      reason: `${'schema validation failed '.repeat(12)}\nwith many details`,
      workDir: '/tmp/work',
    });
    const reasonLine = message.split('\n').find((line) => line.startsWith('reason: '));

    expect(reasonLine).toBeDefined();
    expect(reasonLine?.length).toBeLessThanOrEqual('reason: '.length + 180);
    expect(reasonLine?.endsWith('...')).toBe(true);
  });

  it('uses only the input basename', () => {
    const message = renderTelegramCompletionNotification({
      inputPath: '/tmp/secret/project/task.md',
      exitCode: 0,
      status: 'clean',
      iterations: 0,
    });

    expect(message).toContain('input: task.md');
    expect(message).not.toContain('/tmp/secret/project');
  });
});
