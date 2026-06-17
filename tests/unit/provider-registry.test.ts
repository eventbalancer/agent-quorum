import { describe, expect, it } from 'vitest';
import { resolveWatchdogKnobs } from '../../src/core/knobs.js';
import { PROVIDER_DISPATCH, type ProviderCallInput } from '../../src/providers/provider.js';
import {
  DISABLED_STREAM_KNOBS,
  RUNNER_META,
  RUNNERS,
  isRunner,
  resolveRunnerBinaries,
  type RunnerMeta,
} from '../../src/providers/registry.js';
import type { Runner } from '../../src/types.js';

type AssertEqual<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe('provider registry guard', () => {
  it('anchors the supported runner set', () => {
    // Independent anchor: deleting or renaming a registry entry changes RUNNERS
    // (and, via the compile-time check below, the derived Runner type). Update
    // this expectation only when the supported set deliberately changes.
    expect(RUNNERS).toEqual(['codex', 'claude', 'cursor']);
    const runnerAnchor: AssertEqual<Runner, 'codex' | 'claude' | 'cursor'> = true;
    expect(runnerAnchor).toBe(true);
  });

  it('keeps every dispatch adapter on the shared ProviderCallInput', () => {
    type DispatchParam = Parameters<(typeof PROVIDER_DISPATCH)[Runner]>[0];
    const callInputAnchor: AssertEqual<DispatchParam, ProviderCallInput> = true;
    expect(callInputAnchor).toBe(true);
  });

  it('wires every runner end to end', () => {
    const binaries = resolveRunnerBinaries();
    const stream = resolveWatchdogKnobs().stream;
    for (const runner of RUNNERS) {
      const meta: RunnerMeta = RUNNER_META[runner];
      expect(typeof PROVIDER_DISPATCH[runner], `${runner}: missing dispatch adapter`).toBe(
        'function',
      );
      expect(meta.binary.default.length, `${runner}: empty binary default`).toBeGreaterThan(0);
      expect(meta.install.message.length, `${runner}: empty install message`).toBeGreaterThan(0);
      expect(Array.isArray(meta.auth.args), `${runner}: auth.args is not an array`).toBe(true);
      expect(typeof meta.auth.remedy, `${runner}: auth.remedy is not a function`).toBe('function');
      expect(typeof meta.usesSession, `${runner}: usesSession is not a boolean`).toBe('boolean');
      expect(binaries[runner].length, `${runner}: resolved binary is empty`).toBeGreaterThan(0);
      // Stream metadata present iff the runner actually streams: a streaming
      // entry resolves to live watchdog knobs, a non-streaming one to the
      // disabled sentinel.
      if (meta.stream === undefined) {
        expect(stream[runner], `${runner}: non-streaming runner must use disabled knobs`).toEqual(
          DISABLED_STREAM_KNOBS,
        );
      } else {
        expect(stream[runner], `${runner}: streaming runner must have live knobs`).not.toEqual(
          DISABLED_STREAM_KNOBS,
        );
      }
      expect(isRunner(runner), `${runner}: isRunner is false for a known runner`).toBe(true);
    }
    expect(isRunner('gemini')).toBe(false);
  });
});
