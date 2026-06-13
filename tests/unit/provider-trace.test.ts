import { describe, expect, it } from 'vitest';
import {
  classifyReason,
  describeCommand,
  describeText,
  describeToolActivity,
  ProviderStderr,
  traceLine,
  type TraceContext,
  type TraceKind,
} from '../../src/providers/trace.js';
import {
  cursorStreamJsonEvent,
  streamJsonEvent,
  StreamLogFilter,
} from '../../src/providers/stream-log.js';
import { captureStderr, stripAnsi, withEnv } from '../helpers/harness.js';

function traceContextFixture(provider: TraceContext['provider']): TraceContext {
  return { role: 'critic', provider, model: 'fixture-model' };
}

const stderrStream = process.stderr as unknown as { isTTY: boolean | undefined };
const originalIsTTY = stderrStream.isTTY;
const TRACE_KINDS: readonly TraceKind[] = [
  'tool',
  'text',
  'exec',
  'exec-failed',
  'thinking',
  'retry',
];

interface AdversarialStdoutCase {
  readonly name: string;
  readonly lines: readonly string[];
}

function renderStdoutTrace(lines: readonly string[]): string {
  const claude = lines.flatMap((line) => streamJsonEvent(line)).map(stripAnsi);
  const cursor = lines.flatMap((line) => cursorStreamJsonEvent(line)).map(stripAnsi);
  const filtered = lines.flatMap((line) => new StreamLogFilter(0).line(line)).map(stripAnsi);
  return [...claude, ...cursor, ...filtered].join('\n');
}

function withTty<T>(isTTY: boolean | undefined, fn: () => T): T {
  stderrStream.isTTY = isTTY;
  try {
    return fn();
  } finally {
    stderrStream.isTTY = originalIsTTY;
  }
}

const REDACTION_LEAK_PLANT = 'SECRET-PLANT-7f3a9c-do-not-leak';

describe('traceLine', () => {
  it('renders identical shapes for the same kind deterministically (NFR-1)', () => {
    for (const kind of TRACE_KINDS) {
      const a = stripAnsi(withEnv({ NO_COLOR: '1' }, () => traceLine(kind, 'same body')));
      const b = stripAnsi(withEnv({ NO_COLOR: '1' }, () => traceLine(kind, 'same body')));
      expect(a).toBe(b);
      expect(a).toBe('    same body');
    }
  });

  it('bounds every line to a fixed cap regardless of body size (NFR-2)', () => {
    const huge = 'x'.repeat(50_000);
    for (const kind of TRACE_KINDS) {
      const rendered = stripAnsi(withEnv({ NO_COLOR: '1' }, () => traceLine(kind, huge)));
      expect(rendered.length).toBeLessThanOrEqual(204);
    }
  });

  it('gates ANSI on TTY × NO_COLOR and stripping yields stable text (NFR-3/AC-6)', () => {
    const colored = withTty(true, () =>
      withEnv({ NO_COLOR: undefined }, () => traceLine('tool', 'Read /a.ts')),
    );
    const plain = withTty(true, () =>
      withEnv({ NO_COLOR: '1' }, () => traceLine('tool', 'Read /a.ts')),
    );
    const noTty = withTty(undefined, () =>
      withEnv({ NO_COLOR: undefined }, () => traceLine('tool', 'Read /a.ts')),
    );
    expect(colored).toContain('\x1b[');
    expect(plain).not.toContain('\x1b[');
    expect(noTty).not.toContain('\x1b[');
    expect(stripAnsi(colored)).toBe(plain);
    expect(stripAnsi(colored)).toBe('    Read /a.ts');
  });
});

describe('describeToolActivity', () => {
  it('renders a known target path verbatim and redacts other values', () => {
    expect(describeToolActivity('Read', { path: '/src/a.ts', mode: 'r' })).toBe('Read /src/a.ts');
    expect(describeToolActivity('Edit', { file_path: '/src/b.ts' })).toBe('Edit /src/b.ts');
  });

  it('redacts unknown-tool arguments to key names + size, never values', () => {
    const input = { command: `echo "${REDACTION_LEAK_PLANT}"`, timeout: 5 };
    const rendered = describeToolActivity('Bash', input);
    expect(rendered).not.toContain(REDACTION_LEAK_PLANT);
    expect(rendered).toBe(
      `Bash [command, timeout] (2 keys, ${JSON.stringify(input).length} chars)`,
    );
  });
});

describe('describeText', () => {
  it('emits only kind + size, never prose, and skips empty', () => {
    const prose = `here is a plan:\n${REDACTION_LEAK_PLANT}`;
    const marker = describeText(prose);
    expect(marker).toBe(`text (${prose.length} chars)`);
    expect(marker).not.toContain(REDACTION_LEAK_PLANT);
    expect(describeText('')).toBeUndefined();
  });
});

describe('describeCommand', () => {
  it('renders program + arg/char counts, never the command body', () => {
    const innerCommand = `echo ${REDACTION_LEAK_PLANT}`;
    const descriptor = describeCommand(`/bin/zsh -lc "${innerCommand}" in /repo`);
    expect(descriptor).not.toContain(REDACTION_LEAK_PLANT);
    expect(descriptor).toBe(`echo (1 args, ${innerCommand.length} chars)`);
  });

  it('handles a bare command with no wrapper', () => {
    expect(describeCommand('false')).toBe('false (0 args, 5 chars)');
  });
});

describe('classifyReason', () => {
  it('maps recognized signatures to fixed tokens and omits the rest', () => {
    expect(classifyReason('Error: Overloaded (529)')).toBe('overloaded');
    expect(classifyReason('HTTP 429 too many requests')).toBe('rate-limited');
    expect(classifyReason('401 invalid api key')).toBe('authentication');
    expect(classifyReason('ECONNRESET: socket hang up')).toBe('connection-closed');
    expect(classifyReason('insufficient quota for this request')).toBe('quota');
    expect(classifyReason(`mysterious failure ${REDACTION_LEAK_PLANT}`)).toBeUndefined();
    expect(classifyReason(undefined)).toBeUndefined();
    expect(classifyReason('')).toBeUndefined();
  });
});

describe('stdout redaction contract (Finding 2 / AC-2)', () => {
  const adversarial: readonly AdversarialStdoutCase[] = [
    {
      name: 'full prompt as assistant text',
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [{ type: 'text', text: `full prompt with ${REDACTION_LEAK_PLANT}` }],
          },
        }),
      ],
    },
    {
      name: '10 KB JSON tool input',
      lines: [
        JSON.stringify({
          type: 'assistant',
          message: {
            content: [
              { type: 'tool_use', name: 'Bash', input: { blob: REDACTION_LEAK_PLANT.repeat(400) } },
            ],
          },
        }),
      ],
    },
    {
      name: 'fenced source body in item content',
      lines: [
        JSON.stringify({
          type: 'item.completed',
          item: { content: [{ text: `\`\`\`ts\n${REDACTION_LEAK_PLANT}\n\`\`\`` }] },
        }),
      ],
    },
    {
      name: 'multi-line agent message',
      lines: [
        JSON.stringify({ type: 'agent_message', message: `line1\n${REDACTION_LEAK_PLANT}\nline3` }),
      ],
    },
    {
      name: 'body-bearing exec command',
      lines: [
        JSON.stringify({
          type: 'item.started',
          item: {
            type: 'command_execution',
            command: `/bin/zsh -lc "echo ${REDACTION_LEAK_PLANT}" in /r`,
          },
        }),
      ],
    },
    {
      name: 'command-valued tool argument (cursor)',
      lines: [
        JSON.stringify({
          type: 'tool_call',
          subtype: 'started',
          tool_call: {
            function: { name: 'shell', arguments: `bash -c "${REDACTION_LEAK_PLANT}"` },
          },
        }),
      ],
    },
    {
      name: 'retry reason carrying a planted secret',
      lines: [
        JSON.stringify({
          type: 'system',
          subtype: 'api_retry',
          attempt: 1,
          max_retries: 5,
          delay_ms: 100,
          error: `request failed: ${REDACTION_LEAK_PLANT}`,
        }),
      ],
    },
  ];

  for (const { name, lines } of adversarial) {
    it(`renders only metadata for: ${name}`, () => {
      expect(renderStdoutTrace(lines)).not.toContain(REDACTION_LEAK_PLANT);
    });
  }
});

describe('uniform vocabulary across providers (AC-1)', () => {
  it('renders the same text marker for the codex/claude and cursor renderers', () => {
    const event = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hello world' }] },
    });
    expect(streamJsonEvent(event).map(stripAnsi)).toEqual(['    text (11 chars)']);
    expect(cursorStreamJsonEvent(event).map(stripAnsi)).toEqual(['    text (11 chars)']);
  });

  it('renders the shared command descriptor for an exec event and a cursor command argument', () => {
    const exec = streamJsonEvent(
      JSON.stringify({
        type: 'item.started',
        item: { type: 'command_execution', command: 'git status' },
      }),
    ).map(stripAnsi);
    const cursorCommand = cursorStreamJsonEvent(
      JSON.stringify({
        type: 'tool_call',
        subtype: 'started',
        tool_call: { function: { name: 'git', arguments: 'status' } },
      }),
    ).map(stripAnsi);
    expect(exec).toEqual(['    exec git (1 args, 10 chars)']);
    expect(cursorCommand).toEqual(['    git (1 args, 6 chars)']);
    // Both share the `(<n> args, <m> chars)` descriptor vocabulary.
    expect(exec[0]).toMatch(/\(\d+ args, \d+ chars\)$/);
    expect(cursorCommand[0]).toMatch(/\(\d+ args, \d+ chars\)$/);
  });

  it('uses one `<role>/<provider> call failed` summary vocabulary for every provider', () => {
    for (const provider of ['codex', 'claude', 'cursor'] as const) {
      const capture = captureStderr();
      try {
        const stderr = new ProviderStderr(traceContextFixture(provider));
        stderr.push('boom\n');
        stderr.failureSummary(1);
        expect(capture.text()).toContain(
          `critic/${provider} call failed (status=1, stderr_lines=1)`,
        );
      } finally {
        capture.restore();
      }
    }
  });
});

describe('ProviderStderr bounded buffer and stderr classifier', () => {
  it('counts a huge no-newline line as one line and never logs raw bytes', () => {
    const capture = captureStderr();
    try {
      const stderr = new ProviderStderr(traceContextFixture('claude'));
      stderr.push('first line\n');
      stderr.push('x'.repeat(50_000));
      stderr.push('x'.repeat(50_000));
      stderr.failureSummary(2);
      const text = capture.text();
      expect(text).toContain('critic/claude call failed (status=2, stderr_lines=2)');
      expect(text).not.toContain('x'.repeat(64));
    } finally {
      capture.restore();
    }
  });

  it('classifies a recognized stderr signature and omits an unrecognized one', () => {
    const recognized = captureStderr();
    try {
      const stderr = new ProviderStderr(traceContextFixture('codex'));
      stderr.push('Error: the server is overloaded, retry later\n');
      stderr.failureSummary(1);
      expect(recognized.text()).toContain(
        'critic/codex call failed (status=1, stderr_lines=1): overloaded',
      );
    } finally {
      recognized.restore();
    }

    const plain = captureStderr();
    try {
      const stderr = new ProviderStderr(traceContextFixture('codex'));
      stderr.push('something mysterious happened\n');
      stderr.failureSummary(1);
      const text = plain.text();
      expect(text).toContain('critic/codex call failed (status=1, stderr_lines=1)');
      expect(text).not.toContain('mysterious');
      expect(text).not.toContain('stderr_lines=1):');
    } finally {
      plain.restore();
    }
  });

  it('logs no summary on a zero exit', () => {
    const capture = captureStderr();
    try {
      const stderr = new ProviderStderr(traceContextFixture('codex'));
      stderr.push('whatever\n');
      stderr.failureSummary(0);
      expect(capture.text()).toBe('');
    } finally {
      capture.restore();
    }
  });
});
