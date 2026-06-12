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

## Platform support

| OS            | Status        | CI              |
| ------------- | ------------- | --------------- |
| macOS 13+     | Supported     | `macos-latest`  |
| Linux (glibc) | Supported     | `ubuntu-latest` |
| Windows       | Not supported | —               |

Both macOS and Linux are tested on every push and pull request via the full
`pnpm run check` matrix (build · typecheck · lint · format · tests).

**Provider CLIs on Linux.** The installer commands below apply to most glibc
Linux distros (Ubuntu, Debian, Fedora, Arch). Install each CLI you plan to use:

```sh
npm install -g @anthropic-ai/claude-code   # claude
npm install -g @openai/codex               # codex
```

`cursor-agent` does not have an official Linux package yet. Set
`PLAN_LOOP_CURSOR_BIN` to the path of your Cursor headless binary if you need
the `cursor` runner on Linux:

```sh
export PLAN_LOOP_CURSOR_BIN=/path/to/cursor-agent
```

After installation, authenticate each provider with its own auth command
(`claude auth login`, `codex login`, etc.) — agent-quorum runs a preflight
check before the loop starts and will report a remedy hint for any missing login.

**Optional system dependency.** `plan-loop status` uses `lsof` to resolve the
working directory of a running session when `--work` is not specified. On
minimal Linux environments where `lsof` is absent the command falls back to the
run registry, but workdir detection may be less reliable. Install `lsof` via
your package manager (`apt install lsof`, `dnf install lsof`, etc.) to get the
full experience.

## CLI

A single `plan-loop` bin fronts four entry points:

```sh
plan-loop my-plan.md                      # core loop over an existing plan
plan-loop --prompt my-prompt.md           # create plan.v0 from a prompt first
plan-loop launch --effort high task.md    # detached background run + run.log
plan-loop status [PID]                    # run snapshot (any PID in the tree)
plan-loop intervene --work <dir> "note"   # inject operator guidance mid-run
```

Core-run flags:

| Flag                             | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `--iters N`                      | Set the iteration cap.                                  |
| `--effort {low,high,max}`        | Select the role-call topology and session behavior.     |
| `--fix` / `--no-fix`             | Enable or skip the post-convergence reference fix pass. |
| `--locale <tag>`                 | Set the human-interaction locale; defaults to `en`.     |
| `--translate` / `--no-translate` | Enable or skip the companion final-plan localization.   |
| `--prompt <file>`                | Create `plan.v0` from a prompt before the loop starts.  |

Full flag reference and exit codes live in [`docs/cli.md`](docs/cli.md).
Non-English locales localize Telegram clarification questions and produce
`plan.final.<locale>.md`. Telegram credentials also enable concise final
completion notifications for core runs.

Existing plan inputs are expected to be complete implementation plans, not
summaries or external pointers. The shape gate requires a top-level title,
`## At a Glance`, Context, Verified Facts, Target State, Scope, Work Plan, Files
and Interfaces, Verification, STOP Triggers, and a final `## Impact Graph` with
a Mermaid flowchart. Prompt-created and revised plans are normalized to the same
contract by the packaged role skills.

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

agent-quorum reads one config file: the packaged `plan-loop.json`, or the file
pointed at by `PLAN_LOOP_CONFIG_FILE`. There is no search chain.

`plan-loop.json` has two main sections:

| Section    | Controls                                                          |
| ---------- | ----------------------------------------------------------------- |
| `settings` | Iteration cap, effort, fix pass, locale, translation, retries.    |
| `roles`    | Per-role runner, model, reasoning level, tools, disallowed tools. |

Supported runners are `codex`, `claude`, and `cursor`. Tool permissions stay in
the file so role capabilities are reviewable alongside the role matrix.

Override precedence:

| Surface                          | Precedence                   |
| -------------------------------- | ---------------------------- |
| Loop settings                    | CLI > env > file             |
| Role runner/model/reasoning      | env > file                   |
| Tool permissions                 | file only                    |
| Library `workDir` / `configFile` | typed option > env > default |

A gitignored package-root `.env` is loaded before config resolution, with real
environment variables winning. It is intended for secrets such as Telegram bot
credentials. Those credentials enable final completion notifications
automatically; set `PLAN_LOOP_CLARIFY=0` when you want notifications without the
prompt-mode question gate.

The full reference — every `PLAN_LOOP_*` variable, watchdog knob, Telegram
setting, status/launch toggle, and exact override behavior — lives in
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
- [`docs/development/agent-skill-flow.md`](docs/development/agent-skill-flow.md)
  — repository-local requirements, handoff, prompt architecture, execution, and
  self-planning workflow.

## Development

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm run check          # typecheck + lint + format check + tests with coverage
```

Code style, git, and verification rules live in
[`docs/development/conventions.md`](docs/development/conventions.md).

For changes that should be designed by `agent-quorum` itself, build the package
and run the repository-local dogfood harness:

```sh
pnpm run build
pnpm exec tsx scripts/plan-agent-quorum.ts --prompt .agents/prompts/<slug>.md
```

Harness contract:

- imports the public `agent-quorum` package name;
- writes plan-loop workdirs under `.agents/plans/`;
- accepts `--work`, `--effort`, `--iters`, `--locale`, `--translate`, and
  `--fix` / `--no-fix`.

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
