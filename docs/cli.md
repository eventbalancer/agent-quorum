# CLI

`agent-quorum` is one bin with an umbrella dispatcher. The first argument selects
an entry point: a reserved run-lifecycle command (`launch`, `status`, `show`,
`logs`, `prune`, `intervene`) or a **stage** from the stage registry (`plan` is
the only stage today). There is no default fallthrough — an unrecognized first
token prints the global help to stderr and exits non-zero. After the subcommand
token a single leading `--` is dropped, so a `pnpm run <script> -- <flags>`
forwarding case reaches the stage parser with its flags intact.

Within each entry point the flags, positionals, unknown-flag rejection, and exit
codes are identical to the reference scripts, with one documented deviation: an
explicit `-h`/`--help` prints usage to **stdout** and exits **0** (the reference
run/intervene scripts replied on stderr with exit 1). Error-path usage output
keeps the reference streams and exit codes. `agent-quorum` with no arguments (or
`--help`) prints the global help (stages, run-lifecycle commands, and the
effective defaults from the resolved `agent-quorum.json`); `agent-quorum
--version`/`-V` prints the package version.

ANSI color is emitted only when the target stream is a TTY and `NO_COLOR` is
unset or empty ([no-color.org](https://no-color.org) semantics) — redirected
output and `run.log` stay escape-free; the log text itself is unchanged.
Provider stream logs are metadata-only: tool names, target paths, command and
text sizes, retry/stall markers, status, and counts are logged, but prompt,
plan, source, tool-argument, and raw provider stderr bodies are not mirrored to
normal output. On a non-zero provider exit, `agent-quorum` emits one compact
`<role>/<provider> call failed` summary with status, captured stderr line
count, and a classified reason when one is recognized.

## Plan stage — `agent-quorum plan [flags] <plan.md>`

```text
agent-quorum plan [--iters N] [--effort {low,high,max}] [--no-fix] [--locale LOCALE] [--no-translate] <plan.md>
agent-quorum plan [--iters N] [--effort {low,high,max}] [--no-fix] [--locale LOCALE] [--no-translate] --prompt <prompt.md>
```

| Flag                             | Purpose                                                 |
| -------------------------------- | ------------------------------------------------------- |
| `--iters N` / `--max-iters N`    | Set the iteration cap.                                  |
| `--effort {low,high,max}`        | Select the role-call topology and session behavior.     |
| `--fix` / `--no-fix`             | Enable or skip the post-convergence reference fix pass. |
| `--locale <tag>`                 | Set the human-interaction locale; defaults to `en`.     |
| `--translate` / `--no-translate` | Enable or skip the companion final-plan localization.   |
| `--prompt <file>`                | Create `plan.v0` from a prompt before the loop starts.  |

Flags accept both `--flag value` and `--flag=value` forms for `--iters` /
`--max-iters`, `--effort`, and `--locale`. `--locale <tag>` selects the
human-interaction locale; when omitted, the locale is `en`. Clarification
questions sent through Telegram use that locale. Non-English locales also run
the non-fatal final localization pass and write `plan.final.<tag>.md`; `en`
keeps the final plan English-only. Unknown flags print `unknown flag:` plus
usage and exit 1. One positional input only.

After the fix pass and before the single `FINAL:` status, a deterministic split
policy (`AGENT_QUORUM_SPLIT`, `AGENT_QUORUM_SPLIT_MIN_PHASES`, sized by
`AGENT_QUORUM_MAX_PLAN_LINES` — see [configuration.md](configuration.md)) records
`plan.split.json` and, when it fires, emits and validates a `plan.package/`.
`summary.md` adds a `split_decision` line and, when a package is present,
`package_dir`, `package_documents`, and `package_validation` lines. The final
status folds plan shape, references, and package health into one `FINAL:` log;
a broken package or an empty-Work-Plan forced split blocks the run (exit 6).

Before the loop starts, every runner the effective config selects is
preflighted: installation on `PATH`, then an authentication probe
(`codex login status` / `claude auth status` / `<cursor-bin> status`) with a
3 s timeout per probe — worst case ~9 s before the first provider call when
all three runners are active. An unauthenticated runner exits 1 with a remedy
hint before the first provider call; an indeterminate probe (missing
subcommand, timeout) only warns and never blocks the run.

When Telegram credentials are configured, the core run sends one best-effort
completion notification after success or failure. Exit code 0 is reported as
success, including `needs-review`; non-zero exits report failure with the exit
code and a compact reason. Notification delivery failures are logged as a
warning and do not change the run exit code. `status`, `intervene`, and
launch-parent failures do not send completion notifications; a detached launch
run notifies from its child core run.

Exit codes:

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | converged — clean or needs-review (see `summary.md`) |
| 1    | usage error or failed preflight                      |
| 3    | schema-invalid critique / update / update metadata   |
| 4    | empty or shape-broken creator output; resume failure |
| 5    | workspace-rule violation in the final plan           |
| 6    | final plan or package blocked (broken shape/package) |
| 7    | clarification gate cancelled or failed               |
| 8    | clarification gate transport/conflict failure        |
| 143  | TERM/INT teardown                                    |

## `agent-quorum launch`

```text
agent-quorum launch [--resume] [--iters N] [--effort {low,high,max}] [--prompt] [--no-fix] [--locale LOCALE] [--no-translate] <input.md>
```

Backgrounds the run in its own process group, rotates `run.log`, exports
`CI=true` (and `AGENT_QUORUM_RESUME=1` for `--resume`), verifies liveness, and
prints pid/log/work plus follow/stop hints. Usage errors exit 2; resume workdir
resolution exits 3 (none found) or 4 (ambiguous).

## Selector grammar

`show`, `logs`, and `intervene` (and `status --watch`) resolve a run through one
selector grammar against the durable ledger:

- a bare all-digits token is a **pid** (any process in the run's tree); it only
  ever resolves a **live** run — a finished run's pid is gone;
- a `runId` (or unambiguous prefix; always non-digit-leading) resolves that run;
- any other token is a **name**, resolving the most-recent run with that name;
- `--last` resolves the most-recent run overall; `--work <dir>` addresses an
  explicit workdir without consulting the ledger.

Each run reports its `runId` at start (the `run <id> (<name>)` log line, the
`launch` `run:` block, and `RunResult`/`LaunchResult`), so an older same-named
run stays reachable by `id`/`--last`.

## `agent-quorum status [PID]`

With a PID — **any** process in the run's tree, including provider children —
walks the parent chain to the root run, resolves its workdir, and prints the
process tree, artifact counts, an iteration table computed from the `$WORK`
artifacts, interventions, the last log event, and follow/stop hints.

With no arguments in a TTY, it lists live-first then recent-finished runs and
lets you pick one (a sole candidate auto-selects); a non-TTY prints the same
scriptable listing (`name [state] <shortId> … workdir`) and never blocks.
Discovery sources the durable ledger (records whose pid is alive with a
matching pgid and start token); a `ps` scan (`AGENT_QUORUM_STATUS_SCAN_PS=0`
disables it) remains a secondary path for records-less live trees.

`agent-quorum status --watch [selector]` re-renders the run's status until it
reaches a terminal state (a non-TTY emits a single snapshot); with no selector
it watches the most-recent live run.

Exits 2 for an unknown PID, 3 for a live PID outside any agent-quorum tree.

POSIX `ps` and `lsof` are the port's deliberate external-binary exceptions
(`lsof` only resolves a run's workdir from its open `run.log` handle); tree,
elapsed, and workdir rendering degrade gracefully without them.

## `agent-quorum show <selector>` / `agent-quorum logs <selector> [-f]`

`show` prints a run's `workdir`, `plan.final.md`, `summary.md`, and `run.log`
paths plus a one-line state, resolved by the selector grammar above; an
unresolved selector exits 2.

`logs` prints the run's `run.log` (pure Node; `-f`/`--follow` tail-follows a
live run until it ends). A run that streamed to its console has no `run.log`;
`logs` then prints a clear one-line message pointing at the workdir and exits 0
rather than hanging.

## `agent-quorum prune [--keep N] [--max-age DAYS] [--dry-run]`

Bounds the run ledger by removing **terminal** records beyond `--keep` most
recent (default `AGENT_QUORUM_RETAIN_COUNT`, 50) or older than `--max-age` days
(default `AGENT_QUORUM_RETAIN_DAYS`, 30); `--dry-run` reports what it would remove.
Functional workdirs are never deleted — prune only removes ledger records. Runs
also self-prune at start, so the store stays bounded without manual upkeep.

## `agent-quorum intervene`

```text
agent-quorum intervene --work <workdir> [--target all|critic|creator|fixer|reviewer] <message...>
agent-quorum intervene <name|id|PID|--last|--id ID|--name NAME> [--target ...] <message...>
agent-quorum intervene (--work <workdir> | <selector>) [--target ...] --stdin
```

Appends `{id, ts, target, message}` to `operator-interventions.jsonl`. The
target workdir comes from `--work` or, when absent, from the selector grammar
above. Active entries are injected into the targeted roles' prompts on the next
call and marked migrated once a revision lands. Invalid targets exit 1; a
missing workdir, unresolved selector, or empty message exits 2.
