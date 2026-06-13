import { describe, expect, it, vi } from 'vitest';
import { colorsEnabled, err, log } from '../../src/runtime/log.js';
import { streamJsonEvent } from '../../src/providers/stream-log.js';
import { stripAnsi, withEnv } from '../helpers/harness.js';

const stderrStream = process.stderr as unknown as { isTTY: boolean | undefined };
const originalIsTTY = stderrStream.isTTY;

interface RawStderrCapture {
  text: () => string;
  restore: () => void;
}

// Raw capture (no ANSI stripping) — the escape codes are the subject here.
function captureRawStderr(): RawStderrCapture {
  let buffer = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return {
    text: () => buffer,
    restore: () => {
      spy.mockRestore();
    },
  };
}

function withTty<T>(isTTY: boolean | undefined, fn: () => T): T {
  stderrStream.isTTY = isTTY;
  try {
    return fn();
  } finally {
    stderrStream.isTTY = originalIsTTY;
  }
}

const TOOL_USE_EVENT = JSON.stringify({
  type: 'assistant',
  message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] },
});

describe('colorsEnabled', () => {
  it('follows the TTY × NO_COLOR matrix (empty NO_COLOR keeps color)', () => {
    expect(withTty(true, () => withEnv({ NO_COLOR: undefined }, () => colorsEnabled()))).toBe(true);
    expect(withTty(true, () => withEnv({ NO_COLOR: '1' }, () => colorsEnabled()))).toBe(false);
    expect(withTty(true, () => withEnv({ NO_COLOR: '' }, () => colorsEnabled()))).toBe(true);
    expect(withTty(undefined, () => withEnv({ NO_COLOR: undefined }, () => colorsEnabled()))).toBe(
      false,
    );
    expect(withTty(false, () => withEnv({ NO_COLOR: '1' }, () => colorsEnabled()))).toBe(false);
  });
});

describe('log/err prefixes', () => {
  it('colors the prefix only on a TTY without NO_COLOR; the text never changes', () => {
    const matrix: readonly (readonly [boolean | undefined, string | undefined, boolean])[] = [
      [true, undefined, true],
      [true, '1', false],
      [true, '', true],
      [undefined, undefined, false],
      [false, '1', false],
    ];
    for (const [isTTY, noColor, colored] of matrix) {
      const capture = captureRawStderr();
      try {
        withTty(isTTY, () => {
          withEnv({ NO_COLOR: noColor }, () => {
            log('hello');
            err('boom');
          });
        });
        const text = capture.text();
        if (colored) {
          expect(text).toBe(
            '\x1b[36m[agent-quorum]\x1b[0m hello\n\x1b[31m[agent-quorum]\x1b[0m boom\n',
          );
        } else {
          expect(text).toBe('[agent-quorum] hello\n[agent-quorum] boom\n');
        }
        expect(stripAnsi(text)).toBe('[agent-quorum] hello\n[agent-quorum] boom\n');
      } finally {
        capture.restore();
      }
    }
  });
});

describe('stream renderers', () => {
  it('computes escape codes per call — stubs set after import still gate them', () => {
    const colored = withTty(true, () =>
      withEnv({ NO_COLOR: undefined }, () => streamJsonEvent(TOOL_USE_EVENT)),
    );
    expect(colored[0]).toBe('    \x1b[33mRead (0 keys, 2 chars)\x1b[0m');

    const plain = withTty(true, () =>
      withEnv({ NO_COLOR: '1' }, () => streamJsonEvent(TOOL_USE_EVENT)),
    );
    expect(plain[0]).toBe('    Read (0 keys, 2 chars)');

    const emptyNoColor = withTty(true, () =>
      withEnv({ NO_COLOR: '' }, () => streamJsonEvent(TOOL_USE_EVENT)),
    );
    expect(emptyNoColor[0]).toBe('    \x1b[33mRead (0 keys, 2 chars)\x1b[0m');

    const noTty = withTty(undefined, () =>
      withEnv({ NO_COLOR: undefined }, () => streamJsonEvent(TOOL_USE_EVENT)),
    );
    expect(noTty[0]).toBe('    Read (0 keys, 2 chars)');

    expect(stripAnsi(colored[0] ?? '')).toBe(plain[0]);
  });
});
