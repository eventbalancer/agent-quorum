# agent-quorum

[![npm version](https://img.shields.io/npm/v/agent-quorum.svg?logo=npm&label=npm)](https://www.npmjs.com/package/agent-quorum)

## What it does

Turning a rough idea into an implementation plan a coding agent can actually
execute is hard: a single agent asked to "write the plan" tends to be confident,
shallow, and unchecked — it never argues with itself, and nothing validates that
the result is complete or that the file references it cites are real.

agent-quorum closes that gap. Instead of prompting one agent once, it runs a
panel of agents in an iterative **plan → critique → update** loop: one drafts a
plan, another tears it apart, the draft is revised against that critique, and
the cycle repeats until the criticism runs out. The output is a plan that has
survived adversarial review, has every `file:line` reference checked against
your workspace, and is schema-validated at every step — produced without any
agent ever being granted a tool that can write to disk.

Use it when you want a thorough, self-reviewed plan rather than a first draft,
and you would rather have several agents disagree their way to a good answer
than trust a single pass.

## How the loop works

You hand agent-quorum a prompt or a rough plan. A **creator** writes the first
draft. A **critic** then reviews it and reports concrete issues; the creator
revises the draft to address them. That review-and-revise cycle repeats until
the critic finds nothing left to fix — the point of **convergence** — at which a
reference validator and an optional fix pass clean up the final plan. If the
converged plan is large or has many phases, agent-quorum performs a **split**:
it emits a self-contained `plan.package/` directory so a weaker model can
execute one phase at a time.

Five roles drive that loop: the **creator** drafts and revises, the **critic**
finds issues, the **fixer** proposes reference fixes after convergence, the
**reviewer** checks the fixer's proposal, and the **translator** renders a
localized companion plan when you ask for one.

```text
prompt.md
    │
    │  clarify gate · operator answers blocking questions (Telegram)
    │
    ▼
creator ──► plan.v0.md
                │
    ╭───────────┴───────────╮
    │  critic   → critique  │
    │  creator  → revision  │ ◄── operator interventions
    │  …until convergence   │
    ╰───────────┬───────────╯
                ▼
reference validator ──► fix pass ──► plan.final.md
                                           │
                                           │  split policy (large/complex) ──► plan.package/
                                           │  locale pass (when requested)
                                           │
                                           ▼
                              plan.final.<locale>.md
```

Those five roles map onto three providers (`codex`, `claude`, `cursor-agent`)
through a single declarative config, and every provider call runs in its own
process group under a byte-idle / semantic-idle / wall-clock watchdog.

## Glossary

- **role** — one job in the loop (creator, critic, fixer, reviewer, translator),
  each bound to a provider and a prompt skill.
- **runner** — the provider CLI a role calls: `codex`, `claude`, or `cursor`.
- **quality** — a preset (`quick`, `balanced`, `thorough`) that selects the
  role-call topology, per-role reasoning, and how aggressively provider sessions
  are reused.
- **convergence** — the point where the critic finds no remaining blocking
  issues, so the loop stops and finalizes the plan.
- **split** — emitting the converged plan as a multi-file `plan.package/` when it
  is large or has enough phases, so it can be executed one phase at a time.

## Quickstart

Install the CLI globally:

```sh
npm install -g agent-quorum
```

Prerequisites: Node ≥ 24 and at least one provider CLI (`codex`, `claude`, or
`cursor-agent`) installed **and authenticated** — each selected runner is
preflighted before the loop starts, so a missing login fails fast with a remedy
hint instead of stalling mid-run.

Create a task prompt and run the loop:

```sh
agent-quorum plan --prompt my-task.md
```

By default the run writes its functional artifacts to
`~/.agent-quorum/runs/loop-<name>/` (where `<name>` derives from the input
filename) and its durable run record under `~/.agent-quorum/state/`. The files
you care about are:

- `plan.final.md` — the converged plan; always the entry point.
- `summary.md` — a one-page run summary (iterations, health, artifact paths).
- `plan.package/` — present only when the split policy fires; a self-contained
  directory (index, master plan, per-phase docs, journal, runbook, debt ledger)
  for phase-by-phase execution.

## CLI

A single `agent-quorum` bin fronts these entry points:

```sh
agent-quorum plan my-plan.md                 # core loop over an existing plan
agent-quorum plan --prompt my-prompt.md      # create plan.v0 from a prompt first
agent-quorum launch --quality balanced task.md  # detached background run + run.log
agent-quorum status                          # pick a run (TTY) or scriptable listing
agent-quorum show <name|id|PID|--last>       # a run's artifact paths and state
agent-quorum logs <selector> [-f]            # print or follow a run's run.log
agent-quorum intervene <selector> "note"     # inject operator guidance mid-run
agent-quorum prune [--keep N] [--dry-run]    # bound the run ledger
```

Runs are addressable by a durable `runId`/`name` selector; see the end-to-end
walk-through in [`docs/run-lifecycle.md`](docs/run-lifecycle.md). The full flag
reference and exit codes live in [`docs/cli.md`](docs/cli.md), and the plan
shape gate that existing plan inputs must satisfy is documented in
[`docs/architecture.md#plan-shape-contract`](docs/architecture.md#plan-shape-contract).
Non-English locales localize Telegram clarification questions and produce
`plan.final.<locale>.md`; Telegram credentials also enable concise final
completion notifications for core runs.

## Library

```ts
import { runPlanLoop, getRunStatus, addIntervention, ExitCode } from 'agent-quorum';

const result = await runPlanLoop({ input: 'my-plan.md', iters: 3, quality: 'balanced' });
if (result.exitCode === ExitCode.Ok) {
  console.log(`converged in ${result.iterations} iterations: ${result.finalPlanPath}`);
}
```

The API returns results — only the CLI calls `process.exit`. `runPlanLoop`
returns a structured result (`workDir`, `finalPlanPath`, `summaryPath`,
`iterations`, `health`) built from the same data as `summary.md`. See
[`docs/api.md`](docs/api.md) for the full surface, including CommonJS use.

## Configuration

agent-quorum reads one per-user store that the CLI and the library API resolve
identically: `<home>/config.json` for non-secret settings and an owner-only
`<home>/secrets.json` for the bot token, both under `AGENT_QUORUM_HOME` (default
`~/.agent-quorum`). Configuration is optional — with no store and no environment,
every setting falls back to a built-in default. `config.json` has two main
sections: `settings` (iteration cap, quality, fix pass, locale, translation,
retries) and `roles` (per-role runner, model, and tool permissions). Supported
runners are `codex`, `claude`, and `cursor`.

Run `agent-quorum setup` for guided configuration — essentials (`iters`,
`quality`, `locale`, `translate`), auto-detected per-role runners, and an
optional Telegram step that captures the bot token, discovers the chat id, and
writes the store at owner-only permissions — and `agent-quorum config` to print
the resolved configuration with each value's winning layer. Telegram credentials enable final completion notifications
automatically; set `AGENT_QUORUM_CLARIFY=0` for notifications without the
prompt-mode question gate.

The full reference — every setting and store key, the `AGENT_QUORUM_*` env layer,
watchdog knobs, the env-only rendezvous vars, and the exact
override > env > store > default
[precedence](docs/configuration.md#precedence) — lives in
[`docs/configuration.md`](docs/configuration.md).

## Platform support

| OS            | Status        | CI              |
| ------------- | ------------- | --------------- |
| macOS 13+     | Supported     | `macos-latest`  |
| Linux (glibc) | Supported     | `ubuntu-latest` |
| Windows       | Not supported | —               |

Both macOS and Linux are tested on every push and pull request via the full
`pnpm run check` matrix (build · typecheck · lint · format · tests). Install the
provider CLIs you plan to use (`npm install -g @anthropic-ai/claude-code`,
`npm install -g @openai/codex`) and authenticate each. `cursor-agent` has no
official Linux package yet; point `AGENT_QUORUM_CURSOR_BIN` at your Cursor headless
binary to use the `cursor` runner there (see
[`docs/configuration.md`](docs/configuration.md)). `agent-quorum status` uses
`lsof` to resolve a running session's workdir when `--work` is omitted and
degrades gracefully without it (see [`docs/cli.md`](docs/cli.md)).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — roles, providers, loop
  mechanics, artifact contract, watchdog, sessions.
- [`docs/configuration.md`](docs/configuration.md) — the per-user store and the
  environment-variable surface.
- [`docs/cli.md`](docs/cli.md) — entry points, flags, exit codes.
- [`docs/api.md`](docs/api.md) — typed API and CommonJS consumption.
- [`docs/release.md`](docs/release.md) — release flow across git tags, GitHub
  Actions, GitHub Releases, and npm.
- [`docs/development/conventions.md`](docs/development/conventions.md) — code,
  git, and verification conventions.
- [`docs/development/agent-skill-flow.md`](docs/development/agent-skill-flow.md)
  — repository-local requirements, handoff, prompt architecture, execution, and
  self-planning workflow.
- [`docs/development/adding-a-provider.md`](docs/development/adding-a-provider.md)
  — the two edits that add a CLI provider to the single-source-of-truth runner
  registry.
- [`docs/development/worktree-selection-gate.md`](docs/development/worktree-selection-gate.md)
  — the upfront target-worktree selection protocol shared by `tidy`, `ship`, and
  `execute`.
- [Session Worktrees](docs/development/conventions.md#session-worktrees) — the
  per-session worktree lifecycle (`worktree:create`, `worktree:list`,
  `worktree:touch`, `worktree:done`, `worktree:reopen`, `worktree:release`)
  that isolates concurrent sessions.
- [`examples/`](examples/) — runnable CLI and API walkthroughs of the loop.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check          # typecheck + lint + format check + tests
pnpm run coverage       # tests with V8 coverage thresholds (also enforced in CI)
```

Code style, git, and verification rules live in
[`docs/development/conventions.md`](docs/development/conventions.md).

Work is tracked on the public
[**agent-quorum delivery** board](https://github.com/users/eventbalancer/projects/2):
`Backlog → Todo → In Progress → Done`. The `/issues` skill files session
follow-ups straight into the backlog, where they enter the delivery flow
([`docs/development/agent-skill-flow.md`](docs/development/agent-skill-flow.md)).

For changes that should be designed by `agent-quorum` itself, dogfood the loop
through the `agent-quorum` bin straight from source — see [`examples/`](examples/)
for the full CLI and API walkthrough:

```sh
pnpm run plan:self -- --prompt .agents/prompts/<slug>.md
```

`plan:self` runs `src/cli/main.ts` via `tsx` (no build), points run artifacts at
`.agents/plans/`, and accepts the usual `--quality`, `--iters`, `--locale`,
`--translate`, and `--fix` / `--no-fix` flags; set `AGENT_QUORUM_WORK_DIR` to pin a
workdir name. Its sibling `pnpm run launch:self -- …` takes the same flags but
detaches the run into its own process group, so a run started on your behalf
keeps going after the launching session closes; follow it with
`pnpm run dev -- logs --last -f`.

Artifact ownership:

| Path                          | Role                                 |
| ----------------------------- | ------------------------------------ |
| `.agents/plans/`              | Generated run artifacts; ignored.    |
| `.agents/prompts/`            | Generated prompts; ignored.          |
| `.agents/requirements/`       | Generated requirements; ignored.     |
| `.agents/execution-journals/` | Generated execute journals; ignored. |
| `.agents/skills/`             | Repository-local skill source.       |
| `.claude/commands/`           | Mirrored Claude command source.      |

## License

[MIT](LICENSE) © Aleksei Filippov
