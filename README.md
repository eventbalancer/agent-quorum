# agent-quorum

[![npm version](https://img.shields.io/npm/v/agent-quorum.svg?logo=npm&label=npm)](https://www.npmjs.com/package/agent-quorum)

Iterative **plan → critique → update** orchestrator. It drives the Codex,
Claude Code, and Cursor Agent CLIs to turn a prompt or a rough plan into a
converged implementation plan — every artifact schema-validated, every provider
call watchdogged, and no role ever granted a write tool.

## How it works

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
                                           │  locale pass (when requested)
                                           │
                                           ▼
                              plan.final.<locale>.md
```

Five roles — critic, creator, fixer, reviewer, translator — map onto three
providers (`codex`, `claude`, `cursor-agent`) through a single declarative
config. Every provider call runs in its own process group under a byte-idle /
semantic-idle / wall-clock watchdog.

## Install

```sh
npm install -g agent-quorum   # CLI
npm install agent-quorum      # library
```

Requires Node ≥ 24 and whichever provider CLIs your config selects (`codex`,
`claude`, `cursor-agent`) — installed **and authenticated**. Each selected
runner is preflighted before the loop starts, so a missing login fails fast with
a remedy hint instead of stalling mid-iteration.

## CLI

A single `plan-loop` bin fronts four entry points:

```sh
plan-loop my-plan.md                      # core loop over an existing plan
plan-loop --prompt my-prompt.md           # create plan.v0 from a prompt first
plan-loop launch --effort high task.md    # detached background run + run.log
plan-loop status [PID]                    # run snapshot (any PID in the tree)
plan-loop intervene --work <dir> "note"   # inject operator guidance mid-run
```

Core-run flags: `--iters N`, `--effort {low,high,max}`, `--fix/--no-fix`,
`--locale <tag>`, `--translate/--no-translate`, `--prompt <file>`. Full flag
reference and exit codes live in [`docs/cli.md`](docs/cli.md).
Locale defaults to `en`; non-English locales localize Telegram clarification
questions and produce `plan.final.<locale>.md`.

## Library

```ts
import { runPlanLoop, getRunStatus, addIntervention, ExitCode } from 'agent-quorum';

const result = await runPlanLoop({ input: 'my-plan.md', iters: 3, effort: 'high' });
if (result.exitCode === ExitCode.Ok) {
  console.log(`converged in ${result.iterations} iterations: ${result.finalPlanPath}`);
}
```

The API returns results — only the CLI calls `process.exit`. `runPlanLoop`
returns a structured result (`workDir`, `finalPlanPath`, `summaryPath`,
`iterations`, `health`) built from the same data as `summary.md`. See
[`docs/api.md`](docs/api.md) for the full surface, including CommonJS use.

## Configuration

A single `plan-loop.json` (packaged default; override with
`PLAN_LOOP_CONFIG_FILE`) declares loop settings and the per-role
runner/model/reasoning/tool matrix. The full reference — every `PLAN_LOOP_*`
variable and the override precedence — lives in
[`docs/configuration.md`](docs/configuration.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — roles, providers, loop
  mechanics, artifact contract, watchdog, sessions.
- [`docs/configuration.md`](docs/configuration.md) — `plan-loop.json` and the
  environment-variable surface.
- [`docs/cli.md`](docs/cli.md) — entry points, flags, exit codes.
- [`docs/api.md`](docs/api.md) — typed API and CommonJS consumption.
- [`docs/release.md`](docs/release.md) — release flow across git tags, GitHub
  Actions, GitHub Releases, and npm.
- [`docs/development/conventions.md`](docs/development/conventions.md) — code,
  git, and verification conventions.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check          # typecheck + lint + format check + tests with coverage
```

Code style, git, and verification rules live in
[`docs/development/conventions.md`](docs/development/conventions.md).

## License

[MIT](LICENSE) © Aleksei Filippov
