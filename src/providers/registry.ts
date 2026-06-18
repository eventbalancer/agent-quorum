// Single source of truth for the supported CLI runners. Every mechanical
// per-provider site (config allow-list, dispatch, preflight, runtime wiring)
// derives from RUNNER_META, so adding a provider is one entry here plus one
// dispatch adapter. The module imports only the providers-layer StreamKnobs
// type (no core/types values) to keep the providers boundary and avoid an
// import cycle through Runner.

import type { StreamKnobs } from './watchdog.js';

export interface RunnerMeta {
  readonly binary: { readonly default: string; readonly envOverride?: string };
  readonly defaultModel: string;
  readonly install: { readonly message: string };
  readonly auth: { readonly args: readonly string[]; readonly remedy: (bin: string) => string };
  readonly stream?: {
    readonly envPrefix: string;
    readonly requirePositivePoll: boolean;
  };
  readonly usesSession: boolean;
}

export const RUNNER_META = {
  codex: {
    binary: { default: 'codex' },
    defaultModel: 'gpt-5.5',
    install: { message: 'codex is required' },
    auth: { args: ['login', 'status'], remedy: () => 'codex login' },
    usesSession: false,
  },
  claude: {
    binary: { default: 'claude' },
    defaultModel: 'claude-opus-4-8',
    install: { message: 'claude is required' },
    auth: { args: ['auth', 'status'], remedy: () => 'claude auth login' },
    stream: { envPrefix: 'CLAUDE', requirePositivePoll: true },
    usesSession: true,
  },
  cursor: {
    binary: { default: 'cursor-agent', envOverride: 'AGENT_QUORUM_CURSOR_BIN' },
    defaultModel: 'composer-2.5',
    install: { message: 'cursor-agent is required' },
    auth: { args: ['status'], remedy: (bin) => `${bin} login` },
    stream: { envPrefix: 'CURSOR', requirePositivePoll: false },
    usesSession: true,
  },
} satisfies Record<string, RunnerMeta>;

export type Runner = keyof typeof RUNNER_META;

export const RUNNERS = Object.keys(RUNNER_META) as readonly Runner[];

// Runners whose registry entry carries a `stream` block. Derived from the
// literal RUNNER_META shape (preserved by `satisfies`), so codex — which has no
// stream — is excluded at the type level; the plain Runner union would wrongly
// include it.
export type StreamingRunner = {
  [R in Runner]: (typeof RUNNER_META)[R] extends { stream: object } ? R : never;
}[Runner];

export const STREAM_RUNNERS: readonly StreamingRunner[] = RUNNERS.filter(
  (runner): runner is StreamingRunner => {
    const meta: RunnerMeta = RUNNER_META[runner];
    return meta.stream !== undefined;
  },
);

export function isRunner(value: string): value is Runner {
  return (RUNNERS as readonly string[]).includes(value);
}

// All-zero sentinel for non-streaming runners (codex): the watchdog treats it
// as a no-op and the streamKnobs map entry is never read, keeping the
// Record<Runner, StreamKnobs> total. Frozen because this one instance is shared
// by reference across every ProviderRuntime, so a stray mutation cannot leak.
export const DISABLED_STREAM_KNOBS: StreamKnobs = Object.freeze({
  stallStatus: 0,
  pollSeconds: 0,
  graceSeconds: 0,
  byteTimeoutSeconds: 0,
  semanticTimeoutSeconds: 0,
  wallTimeoutSeconds: 0,
});

// Nullish coalescing keeps an empty-string env override (e.g.
// AGENT_QUORUM_CURSOR_BIN='') as the spawned command rather than falling back to
// the default, matching the historic run.ts resolution exactly.
export function resolveRunnerBinaries(): Record<Runner, string> {
  const binaries = {} as Record<Runner, string>;
  for (const runner of RUNNERS) {
    const meta: RunnerMeta = RUNNER_META[runner];
    binaries[runner] =
      meta.binary.envOverride !== undefined
        ? (process.env[meta.binary.envOverride] ?? meta.binary.default)
        : meta.binary.default;
  }
  return binaries;
}
