# Adding a CLI provider

The supported runners (`codex`, `claude`, `cursor`) are declared once in
[`src/providers/registry.ts`](../../src/providers/registry.ts). `RUNNER_META` is
the single source of truth: the public `Runner` type, the config allow-list and
its validation error, the `runnersInUse` ordering, `providerRun` dispatch, the
preflight install and auth tables, the runtime binary map, and the stream
watchdog knobs all derive from it. Adding a provider is **two edits**.

## 1. Declare the provider in `RUNNER_META`

Add one entry to `RUNNER_META` in `src/providers/registry.ts`:

```ts
myprovider: {
  binary: { default: 'myprovider', envOverride: 'AGENT_QUORUM_MYPROVIDER_BIN' }, // envOverride optional
  install: { message: 'myprovider is required' },
  auth: { args: ['auth', 'status'], remedy: (bin) => `${bin} login` },
  stream: { envPrefix: 'MYPROVIDER', validateEnv: true, requirePositivePoll: true }, // omit for a non-streaming provider
  usesSession: true,
},
```

- `binary.envOverride` is resolved with nullish coalescing, so an empty-string
  override is passed through verbatim (parity with `AGENT_QUORUM_CURSOR_BIN`).
- `stream` is optional. Omit it for a non-streaming provider; the watchdog then
  uses the all-zero `DISABLED_STREAM_KNOBS` sentinel for that runner.
  `validateEnv` and `requirePositivePoll` gate the env validation independently
  (claude validates and requires a positive poll; cursor passes through).

## 2. Add the dispatch adapter in `PROVIDER_DISPATCH`

Add one adapter to `PROVIDER_DISPATCH` in
[`src/providers/provider.ts`](../../src/providers/provider.ts):

```ts
myprovider: (input) => myproviderInvoke(/* fields from input: ProviderCallInput */),
```

`PROVIDER_DISPATCH satisfies Record<Runner, ProviderInvoke>`, so a missing
adapter is a **compile error naming the runner** — the registry entry forces it.
The adapter reads `input.providerRuntime.binaries[runner]` for the command and
`input.providerRuntime.streamKnobs[runner]` for the watchdog cadence.

The **two edits** are the registry wiring. A genuinely new provider also needs
its own invoke module (`myproviderInvoke` plus its streaming/parsing), on par
with `src/providers/{codex,claude,cursor}.ts`; the dispatch adapter above only
calls into it.

## That is all

With those two edits the provider is fully wired: config validation/allow-list,
ordering, dispatch, preflight install and auth, runtime binaries and session
handling, and stream knobs. No other site needs editing. Omitting required
wiring fails mechanically — a compile error, or the guard test
[`tests/unit/provider-registry.test.ts`](../../tests/unit/provider-registry.test.ts),
which names the runner whose wiring is incomplete.

When you **deliberately** change the supported set, update that guard test's
anchored expectation (`expect(RUNNERS).toEqual([...])` and the compile-time
`Runner` equality), which exists to catch an accidental deletion or rename.

## Optional, non-required extras

These are not needed for a provider to validate, dispatch, preflight, or run:

- A display label in [`src/cli/status.ts`](../../src/cli/status.ts) if the new
  provider's process should be recognized in status output by command prefix.
- A distinct fix/translate sub-pass timeout target if the provider needs a
  different cadence for those passes (see
  [`src/stages/plan/fix-pass.ts`](../../src/stages/plan/fix-pass.ts) and
  [`translate-pass.ts`](../../src/stages/plan/translate-pass.ts)).
