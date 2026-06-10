# agent-quorum

Iterative **plan → critique → update** orchestrator that drives the Codex,
Claude Code, and Cursor Agent CLIs to produce and refine implementation plans
until they converge — with schema-validated artifacts, watchdogged provider
calls, a reference validator, an optional fix pass, and an operator
clarification gate over Telegram.

This is a TypeScript implementation with the same flags, artifacts, exit codes,
environment variables, and schemas as the original Bash orchestrator.

## How it works

```text
prompt.md ──(clarify gate)──► creator ──► plan.v0.md
                                              │
                              ┌───────────────▼───────────────┐
                              │  critic (JSON critique)       │
                              │  creator (revised plan)       │◄─ operator
                              │  …until convergence           │   interventions
                              └───────────────┬───────────────┘
                                              ▼
              reference validator ──► fix pass ──► plan.final.md
                                                   └─► plan.final.ru.md (translate pass)
```

Five roles (critic, creator, fixer, reviewer, translator) map onto three
providers (`codex`, `claude`, `cursor-agent`) through a single declarative
config. Every provider call runs in its own process group under a byte-idle /
semantic-idle / wall-clock watchdog; no role is ever granted a write tool.

## Install

```sh
npm install -g agent-quorum   # CLI
npm install agent-quorum      # library
```

Requires Node ≥ 24 and whichever provider CLIs your config selects
(`codex`, `claude`, `cursor-agent`). No other binaries are needed — JSON,
schema validation, and diffing are all in-process.

## CLI

One `plan-loop` bin maps 1:1 onto the four reference entry points
([details](docs/cli.md)):

```sh
plan-loop my-plan.md                      # core loop over an existing plan
plan-loop --prompt my-prompt.md           # create plan.v0 from a prompt first
plan-loop launch --effort high task.md    # detached background run + run.log
plan-loop status [PID]                    # run snapshot (any PID in the tree)
plan-loop intervene --work <dir> "note"   # inject operator guidance mid-run
```

Flags for the core run: `--iters N`, `--effort {low,high,max}`,
`--fix/--no-fix`, `--translate/--no-translate`, `--prompt <file>`.

Exit codes: `0` clean / needs-review, `1` usage or preflight, `3` schema-invalid
artifact, `4` empty or shape-broken creator output, `5` workspace-rule violation
in the final plan, `6` final plan blocked, `7` clarification cancelled, `143`
signal teardown.

## Library

```ts
import { runPlanLoop, getRunStatus, addIntervention, ExitCode } from 'agent-quorum';

const { exitCode } = await runPlanLoop({ input: 'my-plan.md', iters: 3, effort: 'high' });
if (exitCode === ExitCode.Ok) {
  console.log('converged');
}
```

The API returns results — only the CLI calls `process.exit`. See
[`docs/api.md`](docs/api.md).

## Configuration

A single `plan-loop.json` (packaged default; override with
`PLAN_LOOP_CONFIG_FILE`) declares loop settings and the per-role
runner/model/reasoning/tool matrix, with `CLI > env > file` precedence for
loop-tuning knobs and `env > file` for the role matrix. The full reference —
including every `PLAN_LOOP_*` environment variable — lives in
[`docs/configuration.md`](docs/configuration.md).

## Documentation

- [`docs/architecture.md`](docs/architecture.md) — roles, providers, loop
  mechanics, artifact contract, watchdog, sessions.
- [`docs/configuration.md`](docs/configuration.md) — `plan-loop.json` and the
  environment variable surface.
- [`docs/cli.md`](docs/cli.md) — entry points, flags, exit codes.
- [`docs/api.md`](docs/api.md) — typed API.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check          # typecheck + lint + format check + tests with coverage
```

## License

[MIT](LICENSE) © Aleksei Filippov
