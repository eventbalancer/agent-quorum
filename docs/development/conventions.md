# agent-quorum Development Conventions

This document is the single source of truth for agent-quorum development conventions. It covers this project's stack (TypeScript, Node 24, ESM/NodeNext, pnpm, vitest, flat-config ESLint, Prettier, ajv) and architecture (a standalone CLI orchestrator, not a multi-repo workspace).

## Authority

When facts conflict, use this order:

1. This document for code, documentation, git, and verification conventions.
2. `eslint.config.ts` and `tsconfig.json` for machine-enforced rules — when this document and the linter disagree, the linter wins and this document is the bug.
3. `package.json` for scripts, exports, bin, and direct dependencies.
4. `docs/architecture.md` for roles, providers, the loop, and the artifact contract.

If a task exposes a real gap in conventions, scripts, or docs, report what happened, what is missing, and the proposed fix at task end.

## Language

- Code, comments, commits, configuration, tests, and docs use English.
- Operator-facing strings that ship in a non-English locale (the Telegram clarification copy, the companion plan) are selected by the `locale` setting, not hardcoded per language inside business logic. Keep the per-locale copy in one place (see `clarifyCopy` in `src/stages/plan/clarify.ts`) and the default English.

## Source Comments

Source comments are exceptional. Prefer names, types, tests, and structure that explain the code.

Allowed comments:

- critical non-obvious invariants;
- specific external bugs, provider quirks, or runtime constraints (for example why the translator runs claude with `--permission-mode default`);
- behavior that cannot be inferred from names and types.

Do not write comments that:

- restate what the code already says;
- describe the current task, branch, or PR;
- leave TODO/FIXME/HACK breadcrumbs;
- duplicate a function signature;
- preserve commented-out code.

Public API docs (the exported `runPlanLoop` surface in `src/index.ts`) may explain invariants, units, failure modes, and external contracts. Do not write parameter-by-parameter docblocks that repeat the type signature.

### Comment Structure and Length

A comment that earns its place is still short. Lead with one line stating the non-obvious fact, then stop. Growing past a line or two is itself exceptional and must be justified by information the code cannot carry — an enumeration, a provider mapping, an external contract — never by restating the code in prose.

When a comment genuinely needs more than a line, give it structure instead of a run-on paragraph: a summary line, then an aligned block or mapping the reader can scan.

```ts
// One end-to-end smoke run of the plan loop on a single provider's cheap model.
// The positional selects the provider:
//
//   codex    gpt-5.5
//   claude   sonnet
//   cursor   composer-2.5
```

Avoid prose that buries the one fact mid-sentence:

```ts
// A classified receive/transport failure. `errorCode` is the Bot API
// `error_code` from the response body; `status` is the HTTP status. Classification
// prefers the body error_code over the HTTP status (a proxy can diverge them).
```

Tighten to the single fact names and types cannot express:

```ts
// `errorCode` (Bot API body) and `status` (HTTP) can diverge behind a proxy; classification prefers errorCode.
```

## Git

Commit format:

```text
type(scope): subject
```

Allowed types:

```text
feat fix refactor docs test chore perf ci build revert
```

Rules:

- Subject is fully lowercase.
- Header is at most 72 characters.
- Scope is optional.
- No trailing period.
- No `Co-Authored-By` lines.
- Use English.
- Subject and body use plain ASCII printable characters only. No emoji and no decorative Unicode (em or en dashes, smart quotes, arrows, box drawing); write a plain hyphen `-` instead of `—`. Keep the body concise and factual.
- When the work originates from or resolves a GitHub issue, the commit body must link it: `Closes #<n>` when the change fully resolves the issue so it auto-closes on merge, or `Refs #<n>` when the change touches the issue without resolving it. Omit only when no issue is associated.

Do not use force pushes, `--no-verify`, or `--allow-unrelated`. Never commit or push without explicit instruction.

## Project Commands

Use the `package.json` scripts:

```bash
pnpm run build        # tsc -p tsconfig.build.json
pnpm run typecheck    # tsc --noEmit
pnpm run lint         # eslint .
pnpm run format       # prettier --write .
pnpm run format-check # prettier --check .
pnpm run test         # vitest run --coverage
pnpm run check        # build && typecheck && lint && format-check && test
pnpm run dev          # tsx src/cli/main.ts
```

Use `pnpm exec <bin>` for repo-local binaries; never `npx`. `pnpm run check` green is the floor before claiming an implementation is done.

## Pre-commit Hook

The repository ships a pre-commit hook in `.githooks/pre-commit`. It runs
automatically on `git commit`:

1. `pnpm run format` — rewrites all files with Prettier.
2. `git add -u` — re-stages any files the formatter changed.
3. `pnpm run check` — runs the full build · typecheck · lint · format-check ·
   test pipeline; the commit is blocked if any step fails.

The hook is activated via `core.hooksPath .githooks`. `pnpm install` sets this
up through the `prepare` lifecycle script so any fresh clone works after
install. Never pass `--no-verify` to bypass the hook; the conventions forbid
it.

## Session Worktrees

Multiple agent sessions share one repository. To keep a session's work isolated,
nontrivial work runs in its own linked git worktree on a `session/<slug>` branch,
so the unmodified pre-commit hook stages and validates only that tree.

Use a session worktree for nontrivial, multi-file, or potentially concurrent
work; trivial solo edits may stay in the shared checkout.

Start one with a required task description, so a durable record always exists:

```bash
pnpm run worktree:create <slug> --desc "<what this worktree is for>"
pnpm run worktree:create <slug> --desc-file path/to/task.md
pnpm run worktree:create <slug> --desc "..." --from <ref>   # branch from an explicit base
```

Without `--from`, the default base (`main`) is fast-forwarded to its upstream
before branching, so a session never starts from a stale `main` regardless of the
provider CLI driving the loop. The sync is best-effort and fast-forward-only: a
missing `origin`, no upstream, an offline fetch, a diverged base, or a dirty
checkout leaves the local ref untouched and the worktree is still created. Passing
an explicit `--from <ref>` skips the sync and bases the worktree on that ref
verbatim.

This creates the worktree at `$HOME/.agent-quorum/worktrees/agent-quorum/<slug>`
on branch `session/<slug>`, runs `pnpm install --frozen-lockfile` there, and
writes two carriers into the worktree's git admin directory (outside any working
tree, so the hook never sees them): the task description `agent-quorum-task.md`
and the active-edit marker `agent-quorum-active-edit.json`. The per-worktree
install reuses pnpm's global content-addressable store, so a warm store hardlinks
rather than re-downloads.

Enter the worktree with the harness `EnterWorktree <path>` tool, or `cd <path>`,
and run every command — including `pnpm run check`, the per-worktree definition of
done — inside it. For work already begun in the shared checkout, carry it over
with a patch rather than re-editing: `git -C <shared> diff > /tmp/wip.patch`, then
`git apply /tmp/wip.patch` inside the worktree.

The hook is byte-for-byte unchanged; isolation comes from where it runs. Its
relative `core.hooksPath` (`.githooks`) resolves against each worktree's own
checkout top. A linked worktree's `.git` is a file, so its own `prepare` step
skips the `[ -d .git ]` guard and does not set the config; `worktree:create`
therefore sets `core.hooksPath` explicitly after `git worktree add`. A
`git commit` inside the worktree then runs `git add -u` and `pnpm run check`
against only that worktree's tree.

Commit rules are unchanged: plain-ASCII messages, `Closes #<n>` / `Refs #<n>`
issue linking, and never `--no-verify`.

Refresh the active-edit marker so other sessions can see the worktree is live:
`worktree:create` writes it, and `pnpm run worktree:touch <slug>` refreshes it.
Run `touch` at the start of a work burst and before each verification or commit.
The selection gate's dirty-tree fallback covers any lapse, so a stale marker
never reads idle.

Integrate to `main` via `/ship` plus an explicit merge or PR step, with conflicts
surfaced there; integration is never automatic. A same-file edit in two sessions
yields a surfaced conflict, not silent loss.

Clean up non-destructively from the primary checkout (not from inside the
target):

```bash
pnpm run worktree:release <slug>                  # integration base defaults to main
pnpm run worktree:release <slug> --into origin/main
```

`release` verifies the integration base resolves, runs a merge-safety preflight
(`git merge-base --is-ancestor`), aligns `git branch -d`'s own merged-check to
that base, and removes the worktree then the branch. It refuses dirty or unmerged
work and removes nothing rather than forcing; there is no `--force` path.

### Session worktree acceptance runbook

These checks are operational — they need two trees and a real install, so they
run manually rather than in the network-guarded test suite.

- AC-1/AC-2: with dirty changes in the primary checkout,
  `pnpm run worktree:create demo --desc "<task>"`; confirm the hook precondition
  (`git -C <wt> config --get core.hooksPath` is `.githooks`,
  `<wt>/.githooks/pre-commit` exists). Make a tracked edit in the worktree, then —
  as an explicit operator-authorized step — `git commit` inside it and watch the
  hook run `pnpm run check` green with no `--no-verify`. `git -C <wt> status` shows
  only the worktree's files; the primary checkout's tracked and untracked changes
  are unchanged. Tear the proof down with no forbidden command:
  `git -C <wt> reset --soft HEAD~1` and
  `git -C <wt> restore --staged --worktree -- <file>`, then
  `pnpm run worktree:release demo` from the primary checkout.
- AC-3: in a fresh worktree, `pnpm run check` runs green after the documented
  `pnpm install --frozen-lockfile`.
- AC-4: this section documents the start, commit, handoff, and marker-refresh
  cadence.
- AC-5: the session branch reaches `main` via `/ship` plus the explicit merge/PR
  step; a same-file edit in two sessions yields a surfaced conflict, not silent
  loss.
- AC-6: run `release` from the primary checkout. For an unmerged branch it refuses
  at the merge-safety preflight and removes nothing; invoking it on the worktree
  you stand in refuses cleanly. After integration (or after resetting a disposable
  proof commit off), `release` removes the worktree and branch, leaving the path
  absent from `git worktree list --porcelain` and `git branch --list 'session/demo'`
  empty, with unrelated `session/*` worktrees untouched; no force flag is ever used.
- AC-7: from another session, `git -C <wt> rev-parse --absolute-git-dir` then
  reading `agent-quorum-task.md` returns the description supplied at `create`.
- AC-8: a dirty worktree reads active via the fallback; a clean worktree refreshed
  within the TTL reads active via the marker; a clean worktree with a stale marker
  reads "possibly active / uncertain", never idle.

## Linting and Editor Tooling

- ESLint is flat-config only (`eslint.config.ts`). Do not add `.eslintrc*` files.
- The config layers `@eslint/js` recommended, `typescript-eslint` `strictTypeChecked` + `stylisticTypeChecked`, the per-layer architecture and convention blocks, and `eslint-config-prettier` as the last formatting-disabling entry. The sole config object after `eslint-config-prettier` re-enables `curly` — a structural brace rule it switches off, owned by ESLint, not Prettier. Prettier owns formatting; ESLint owns correctness and style-of-types.
- `strictTypeChecked` bans `any` (`no-explicit-any`), unsafe assignments, and floating promises. `stylisticTypeChecked` enforces `@typescript-eslint/consistent-type-definitions` (`interface` for object shapes) among others. Do not disable these per-line to dodge a real finding — fix the code.
- Type-aware linting uses `projectService`; new files must be inside the `tsconfig.json` `include` globs (`src`, `tests`) or lint will not type-check them.

### Enforcement Boundary Map

Each project convention has exactly one owner. This table is the authoritative map; when a section below names an owner, it points here. Machine-checked conventions block `pnpm run lint` / `pnpm run check`; the rest are human review.

| Convention                                                                  | Owner        | Mechanism                                                         | Notes                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------- | ------------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pure formatting (quotes, semicolons, spacing, trailing commas, print width) | Prettier     | `.prettierrc`, `pnpm run format-check`                            | No formatting rule in ESLint                                                                                                                                                                                                                                                                                                                                          |
| Control-flow block shape (braces)                                           | ESLint       | `curly: ['error', 'all']` on `src/**`                             | Multi-line expansion nuance beyond brace presence is out of machine scope (human review)                                                                                                                                                                                                                                                                              |
| Logging boundary (`console.*` in core/providers)                            | ESLint       | `no-console: error` on `src/core/**`, `src/providers/**`          | —                                                                                                                                                                                                                                                                                                                                                                     |
| Inward-only layer imports                                                   | ESLint       | `@typescript-eslint/no-restricted-imports` per layer + stages ban | Machine-forbids the `cli` edge for `core`/`providers`/`channels`, the full outward set for `runtime`, `stages` for all layers, and `providers`/`channels -> core` except `core/json` (any) and `core/config` (type-only); `core/config` value imports are rejected; `core -> {providers, channels}` is inward and allowed; lateral `providers <-> channels` is review |
| Generic module names (helpers/common/misc/utils)                            | ESLint       | `no-restricted-syntax` `Program` selector on banned-name globs    | Banned under `src/`                                                                                                                                                                                                                                                                                                                                                   |
| Object literal layout                                                       | human review | Prettier preserves an already-multi-line literal                  | Not an ESLint check (D-1)                                                                                                                                                                                                                                                                                                                                             |
| Complex call arguments                                                      | human review | —                                                                 | Not an ESLint check (D-1)                                                                                                                                                                                                                                                                                                                                             |
| Boolean naming                                                              | human review | —                                                                 | Not an ESLint check (D-1)                                                                                                                                                                                                                                                                                                                                             |
| Source comments                                                             | human review | —                                                                 | Not an ESLint check (D-1)                                                                                                                                                                                                                                                                                                                                             |

## TypeScript Compiler

`tsconfig.json` is strict and unforgiving by design. Write code that satisfies it without casts:

- `strict`, `noUncheckedIndexedAccess` — index access yields `T | undefined`; narrow it.
- `exactOptionalPropertyTypes` — an optional field is absent, not `undefined`-valued; do not assign `undefined` to satisfy it.
- `noFallthroughCasesInSwitch` — every `case` terminates.
- `verbatimModuleSyntax` — use `import type` / `export type` for type-only imports; emit-affecting imports stay value imports.
- `isolatedModules`, `module: NodeNext` — ESM only; relative imports carry the `.js` extension (`./config.js`), matching the compiled output.

## Architecture

agent-quorum is a standalone CLI that orchestrates the Codex, Claude Code, and Cursor Agent CLIs through an iterative plan → critique → update loop. It must build, test, and run from its own checkout with no external workspace. See `docs/architecture.md` for the roles, providers, loop, and artifact contract.

Source layers, outer depends on inner:

```text
cli -> core -> {providers, channels} -> runtime
```

- `src/cli/` owns argument parsing and command entry points (`main`, `run`, `launch`, `intervene`, `help`). It resolves settings and builds the `RunContext`; it holds no orchestration logic.
- `src/core/` owns the orchestration domain: config resolution, the iteration loop, the critic/creator/fixer/reviewer/translate passes, the clarification gate, plan validation, resume, summaries, and the run context. Pure decision logic lives here.
- `src/providers/` owns the three provider adapters (codex, claude, cursor) behind a single `providerRun` entry point that owns retry, streaming, and the watchdog. Provider-specific quirks stay here.
- `src/runtime/` owns low-level technical primitives: process exec and teardown, env/dotenv loading, logging, filesystem helpers, scratch dirs, and the `HaltError` exit contract. No domain knowledge.
- `src/channels/` owns operator communication channels — the Telegram Bot API client and completion-notification rendering today. It is the external messaging transport the clarification gate and completion notifier consume; it depends only on `runtime/` and `core/` JSON types, and holds no orchestration logic.
- `skills/` holds the role prompt skills and their JSON schemas, validated with ajv. Treat a skill `*.schema.json` as a contract: changing it changes the provider I/O shape.

Rules:

- Dependencies point inward only. `runtime/` imports nothing from `core/`, `providers/`, or `cli/`; `core/` does not import `cli/`. ESLint machine-enforces this direction per layer with `@typescript-eslint/no-restricted-imports` — the `cli` edge for `core`/`providers`/`channels`, the full outward set for `runtime`, the `stages` boundary for every layer, and `providers`/`channels -> core` except `core/json` (any import) and `core/config` (type-only); see the Enforcement Boundary Map.
- A helper used by one pass lives with that pass in `core/`, not in a shared bucket. Promote to a shared module only when a second consumer appears.
- Provider calls go through `providerRun`; never spawn a provider CLI directly from `core/` or `cli/`.

## Modules, Exports, and Imports

Use named exports. Avoid `export default` (the one exception is a future tool that genuinely requires it; none exists today).

```ts
export function resolveRunSettings(cli: CliSettings, file: string): RunSettings {
  // ...
}
```

Rules:

- Preserve public exports of `src/index.ts` unless a breaking change is explicit.
- ESM relative imports use the `.js` extension and import the specific module, not a re-export barrel, unless a barrel already exists.
- Generated and packaged files (`dist/`, `coverage/`, `pnpm-lock.yaml`) are never hand-edited.

## Naming and Structure

Use domain names first, then technical role names. Prefer a precise file name (`translate-pass.ts`, `validate-plan.ts`, `clarify.ts`) over a catch-all. Avoid new generic `helpers`, `common`, `misc`, or `utils` buckets; `src/runtime/` already holds the genuinely generic primitives. The `helpers`/`common`/`misc`/`utils` ban under `src/` is ESLint-enforced (`no-restricted-syntax`); see the Enforcement Boundary Map.

Do not abbreviate domain terms in project-owned names. Prefer `traceContext`, not `traceCtx`; `providerRuntime`, not `rt`; `runContext`, not `ctx`; `iteration`, not `iter`; and `previousCritiques`, not `prevCritiques`.

## TypeScript Style

### Blocks

Use braced, multi-line bodies for all control flow and function bodies, even for a single statement.

```ts
if (!settings) {
  return null;
}

for (const role of roles) {
  preflight(role);
}
```

Avoid brace-less or single-line control flow:

```ts
if (!settings) return null;
for (const role of roles) preflight(role);
```

This applies to every `if` / `else if` / `else` / `for` / `while` / `do…while` / `try` / `catch` / `finally`, and to function and method bodies. When you touch a file, bring the lines you change into this shape. ESLint enforces brace presence with `curly: ['error', 'all']` on `src/**`; the multi-line expansion nuance beyond brace presence stays human review. See the Enforcement Boundary Map.

### Arrow Functions

Concise arrow bodies are fine for short, pure expressions:

```ts
const ids = entries.map((entry) => entry.id);
const active = roles.filter((role) => role.enabled);
```

Use a braced body with an explicit `return` when the callback has side effects, multiple steps, a long expression, nested logic, a non-trivial returned object literal, or exported behavior.

### Named Types

Extract object parameter and return shapes when they stop being trivial.

Extract when:

- a destructured parameter bag has three or more fields;
- a field is a union, generic, nested object, or array of objects;
- the function is exported;
- the object return has two or more fields;
- the shape is reused.

Use PascalCase and name them `<Function>Params` / `<Function>Result` (or `<Name>Options` for many-optional-field config).

Definition keyword — match the linter (`consistent-type-definitions`):

- Use `interface` for object shapes (parameter bags, return shapes, config records, role tables).
- Use `type` only for what an interface cannot express: unions, intersections, mapped/conditional types, tuples, and function-type aliases. The discriminated `WaitOutcome` union in `src/stages/plan/clarify.ts` is the model.

```ts
interface ResolveTranslatePassParams {
  readonly cliLocale: string;
  readonly envLocale: string;
  readonly fileLocale: string;
}

type WaitOutcome =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'cancel' }
  | { readonly kind: 'deadline' };
```

Extract a multi-member union into its own named `type` instead of inlining it on a field, parameter, or return. A union of three or more members — string-literal sets, discriminated object unions, or mixed alternatives — earns a name; do not spell it out where it is used. Name the literal set after the domain concept it enumerates (`TelegramFailureKind`, not `Kind`).

```ts
export type TelegramFailureKind =
  | 'http'
  | 'conflict'
  | 'unauthorized'
  | 'network'
  | 'timeout'
  | 'envelope'
  | 'parse';

export interface TelegramFailure {
  readonly kind: TelegramFailureKind;
  readonly status?: number;
}
```

Avoid inlining the same set on the field:

```ts
export interface TelegramFailure {
  readonly kind:
    | 'http'
    | 'conflict'
    | 'unauthorized'
    | 'network'
    | 'timeout'
    | 'envelope'
    | 'parse';
  readonly status?: number;
}
```

A two-member union local to one signature (`string | undefined`, `'get' | 'post'`) can stay inline.

### Type Safety

Use `unknown` plus narrowing at boundaries (parsed JSON, provider output, env). Do not use `any` — `strictTypeChecked` already forbids it; do not cast it back in with `as`.

Use discriminated unions and exhaustive checks. `noFallthroughCasesInSwitch` is on; close exhaustive switches with `satisfies never`:

```ts
switch (outcome.kind) {
  case 'answer': {
    return outcome.text;
  }
  case 'cancel': {
    return undefined;
  }
  case 'deadline': {
    throw new HaltError('clarify deadline', 1, true);
  }
  default: {
    outcome satisfies never;
    throw new Error('unreachable');
  }
}
```

Use `readonly` by default for fields and array parameters; widen only where the function genuinely mutates.

### Nullability

Prefer `undefined` for absent values inside the domain. Use `null` only when an external system returns it; normalize at the boundary. Settings model "no value" as `undefined` on `CliSettings` and as the empty string only where the resolution chain already treats empty as missing.

### Time

`Date.now()` and `new Date()` are I/O. Keep them at the edges (the clarification deadline, run timestamps) and out of pure decision functions where practical; pass an injected clock when a function's result depends on the current time and needs to be tested.

### Values

Name meaningful literals as module constants (SCREAMING_SNAKE for primitives, `as const` objects for groups):

```ts
const DEFAULT_LOCALE = 'en';
const LEGACY_TRANSLATE_LOCALE = 'ru';
```

Inline literals only when they are local and self-evident (`0`, `1`, `''`).

### Shape-Varying Literals

Do not build a single object literal whose structure switches on a mode flag through inline ternaries and conditional spreads. When a boolean selects between two different shapes, branch first and return each shape explicitly.

Avoid:

```ts
const response = await fetch(options.get ? `${url}?${query}` : url, {
  method: options.get ? 'GET' : 'POST',
  ...(options.get ? {} : { headers, body: query }),
  signal,
});
```

Prefer a helper that returns the variant directly, so each branch reads as one concrete request:

```ts
function buildRequest(options): { url: string; init: RequestInit } {
  if (options.get) {
    return { url: `${url}?${query}`, init: { method: 'GET', signal } };
  }
  return { url, init: { method: 'POST', headers, body: query, signal } };
}
```

This is distinct from the conditional spread used to omit a single optional field under `exactOptionalPropertyTypes` (`...(status !== undefined ? { status } : {})`), which stays allowed: there the shape is constant and only one field's presence varies. The rule targets literals whose overall structure — which keys exist, what the method is — flips on a flag.

### Object Literal Layout

Once an object literal carries a conditional spread or three or more fields, write it multi-line with one field per line. Prettier preserves the multi-line form whenever a newline follows the opening brace, so the layout is the author's to set — keep it expanded rather than letting fields collapse onto one line. This is not lint-enforced; honor it when you write or touch the literal.

```ts
return {
  kind,
  ...(status !== undefined ? { status } : {}),
  ...(errorCode !== undefined ? { errorCode } : {}),
  ...(description !== undefined ? { description } : {}),
};
```

Avoid collapsing a conditional-spread literal onto one line even when it fits:

```ts
return { kind: 'envelope', ...(description !== undefined ? { description } : {}) };
```

A flat literal of one or two plain fields (`{ ok: true, body }`) stays inline.

### Call Arguments

Do not inline a complex argument at a call site. Bind a multi-field object literal, an array of objects, or a non-trivial computed expression to a named `const` (or extract a builder helper) on the lines before the call, then pass the name. Name it after the operand and the callee, not generically (`getUpdatesParams`, not `params`). The call should read as a verb over named operands, not as a wall of nested literals. A flat one- or two-field literal with no computation may stay inline.

Avoid burying the operands inside the call:

```ts
const result = await telegramCall(
  'getUpdates',
  {
    offset: String(offset),
    timeout: String(timeout),
    allowed_updates: '["message"]',
  },
  {
    get: true,
    timeoutSeconds: options.httpTimeoutSeconds ?? timeout + TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS,
  },
);
```

Name the operands first, so the call is one readable line. Bind the call's own result to a name derived from the callee (`telegramCallResult`, not `result`) rather than a bare `result`/`res`/`data`:

```ts
const getUpdatesParams = {
  offset: String(offset),
  timeout: String(timeout),
  allowed_updates: '["message"]',
};
const httpTimeoutSeconds =
  options.httpTimeoutSeconds ?? timeout + TELEGRAM_HTTP_TIMEOUT_SLACK_SECONDS;
const telegramCallResult = await telegramCall('getUpdates', getUpdatesParams, {
  get: true,
  timeoutSeconds: httpTimeoutSeconds,
});
```

### Booleans and Declarations

Booleans start with `is`, `has`, `can`, `should`, `did`, or `will`, and are named positively (`isReady`, not `isNotReady`). Extract a named boolean for any condition that joins three or more predicates or mixes negation with domain terms.

Use `const` by default. Use `let` only for genuine reassignment — prefer a guard-clause helper that `return`s over a `let` reassigned across an if/else ladder. Never use `var`; always use `===`.

## Errors

Throw typed errors with a stable, machine-readable shape. The project's exit contract is `HaltError` (carries an exit code); use it for operator-facing fatal exits and let it propagate to the CLI boundary.

Catch as `unknown` and narrow with `instanceof`. Catch narrowly at boundaries (a `JSON.parse` that may throw, a provider call that may fail) and turn the failure into a typed result or a `HaltError` — do not swallow errors silently and never branch on `err.message`.

## Logging

- Log through `src/runtime/log.ts` (`log` / `err`); do not call `console.*` directly in `core/` or `providers/`. ESLint enforces this with `no-console` on `src/core/**` and `src/providers/**`; see the Enforcement Boundary Map.
- Logs carry run metadata — role, provider, model, status, line counts, latency — not plan bodies, prompts, or secrets.
- The provider trace is metadata-only on both streams: tool-argument values, assistant prose, raw command bodies, and free-text retry/stderr reasons render as a kind, size, target path, command descriptor, or classified token — never the body. Raw stdout/stderr is reachable only behind the opt-in `AGENT_QUORUM_PROVIDER_DIAGNOSTICS` escape hatch (see [`docs/configuration.md`](../configuration.md)).

## Security and Secrets

- Never commit `.env` files, tokens, or keys. Telegram and provider credentials (`AGENT_QUORUM_TELEGRAM_BOT_TOKEN`, `AGENT_QUORUM_TELEGRAM_CHAT_ID`, provider auth) come from the environment.
- Keep any `.env.example` current when local config keys change.
- Do not paste real secrets into docs, issues, commits, tests, logs, or prompts.

## Path Portability

Committed code and docs must work for any developer machine and clone location.

- Resolve user-local artifacts under `$HOME/.agent-quorum` — functional output in `runs/`, the durable run ledger in `state/` (overridable via `AGENT_QUORUM_HOME`, or the legacy `AGENT_QUORUM_PLANS_DIR` / `AGENT_QUORUM_STATE_DIR` / `AGENT_QUORUM_WORK_DIR`); resolve packaged assets relative to `packageRoot()`.
- In committed code and docs use `$HOME`, `~`, env vars, or package-relative paths — never an absolute clone path such as `/Users/<username>/...`.
- `docs/` and journals may keep historical absolute paths as an audit trail; do not normalize them retroactively.

Make breaking changes additively when there are external consumers of `src/index.ts`: add the new surface, migrate consumers, remove the old surface last — not in one commit.

## Documentation

- Documentation is code-adjacent and must stay current with changed behavior.
- Active docs (`README.md`, `docs/`, skill prompts) describe current behavior, not migration history.
- When code changes paths, flags, config keys, types, the public API, or the artifact contract, update the related docs (`docs/cli.md`, `docs/configuration.md`, `docs/api.md`, `docs/architecture.md`, `README.md`, and any affected skill) in the same change.
- Keep docs readable: one topic per section, short tables for matrices, commands in fenced blocks.

## Dead Code and Cleanup

- An export is dead when nothing in `src`, `tests`, or `skills` references it — check imports, re-exports, tests, and string/schema references before deleting.
- Delete proved-dead code and commented-out code; inline a helper that drops to a single caller.
- Ask before changing reachable but suspicious logic.
- Typecheck after small cleanup batches so false positives are easy to isolate.

## Test Network Isolation

The test suite runs behind an always-on network guard
(`tests/helpers/network-guard.mjs`) so a run can never perform a real external
network side effect, regardless of any credentials or `.env` values present on
the machine. The guard blocks every outbound connection whose destination host
is not loopback (`127.0.0.0/8`, `::1`, `localhost`) or an IPC socket; loopback
classification is by numeric IP literal, so a hostname like `127.example.test`
is treated as remote.

- It installs in-process in each worker through `vitest` `setupFiles`, and in
  every spawned **Node** child through an inherited `NODE_OPTIONS=--import` that
  the guard self-appends.
- A test that needs a server must bind `127.0.0.1` (the Telegram stub already
  does); local servers and the in-process stub keep working unchanged.
- A blocked attempt is identifiable by the `agent-quorum network guard` marker
  on `stderr` and a rejected/`AGENT_QUORUM_NETWORK_BLOCKED` error.
- Any new test that spawns a Node process must let it inherit `process.env` (the
  default) for the guard to apply.
- Reach is Node-only: `NODE_OPTIONS=--import` does not reach non-Node children.
  The suite spawns only non-egressing bash fake bins; if a test ever spawns a
  non-Node command that can egress, it needs its own isolation.

## Verification

Scale verification to risk and blast radius.

Routine change:

```bash
pnpm run typecheck
pnpm run lint
```

Before claiming done, or for any behavior change:

```bash
pnpm run check
```

`pnpm run typecheck` green is the floor; `pnpm run check` green (typecheck + lint + format-check + tests with coverage) is the bar for a finished change.
