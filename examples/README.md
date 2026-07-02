# Examples

Two ways to drive agent-quorum, both shown end to end:

- **CLI** — the `agent-quorum` bin, exactly as an installed user runs it.
- **API** — the `agent-quorum` package, in [`api.ts`](api.ts).

Everything here uses the same public surfaces the tool ships; there is no
example-only wrapper. [`task.example.md`](task.example.md) is a tiny sample
prompt you can feed to either path.

Prerequisites: Node ≥ 24 and at least one authenticated provider CLI (`codex`,
`claude`, or `cursor-agent`).

## Two ways to invoke the CLI

| Context          | Command                      | Build needed?                   |
| ---------------- | ---------------------------- | ------------------------------- |
| Installed user   | `agent-quorum …`             | n/a (global bin)                |
| Inside this repo | `pnpm run run:cli -- plan …` | no (runs from source via `tsx`) |

`run:web` and `run:cli` in `package.json` both run `src/cli/main.ts` via `tsx`
(no build) with run artifacts pointed at this repo's `.agents/plans/` ledger.
`run:web` with no arguments opens the local web workspace; bare `run:cli` prints
CLI help. Forward subcommands with `pnpm run run:cli -- <command>`, so
`pnpm run run:cli -- plan …` reads as `agent-quorum plan …` for an installed
user. The run-lifecycle commands (`launch`, `status`, `show`, `logs`,
`intervene`) are not part of the `plan` stage; from source drive them through
`pnpm run run:cli -- <command>` (the same repo ledger), which an installed user
spells `agent-quorum <command>`.

## CLI walkthrough

```sh
# 1. Plan from a task prompt (creates plan.v0, then loops to convergence).
pnpm run run:cli -- plan --prompt examples/task.example.md --quality balanced --iters 3

# 1b. Or refine an existing plan file instead of a prompt.
pnpm run run:cli -- plan my-plan.md

# 2. Detach a long run into its own process group with run.log redirection.
pnpm run run:cli -- launch --quality balanced --prompt examples/task.example.md

# 3. Inspect runs.
pnpm run run:cli -- status            # list runs (interactive picker in a TTY)
pnpm run run:cli -- show --last       # artifact paths + state of the latest run
pnpm run run:cli -- logs --last -f    # follow a detached run's log until it ends

# 4. Steer a run mid-flight.
pnpm run run:cli -- intervene --last "prefer an additive migration"
```

When the loop converges it writes, under the run's workdir:

- `plan.final.md` — the converged plan; always the entry point.
- `summary.md` — one-page run summary (iterations, health, artifact paths).
- `plan.package/` — present only when the split policy fires.

## API walkthrough

[`api.ts`](api.ts) runs the same loop through the typed package API, which
returns a structured `RunResult` and never calls `process.exit`:

```sh
pnpm run build   # the example imports the published "agent-quorum" name
AGENT_QUORUM_PLANS_DIR=.agents/plans pnpm exec tsx examples/api.ts examples/task.example.md
```

It calls `runPlanLoop`, prints the convergence health, then reads the run back
out of the durable ledger with `listRuns` and `getRunStatus` — the API
counterparts of `agent-quorum status`. See [`../docs/api.md`](../docs/api.md) for
the full surface, including `launchPlanLoop`, `addIntervention`, and
`pruneRuns`.
