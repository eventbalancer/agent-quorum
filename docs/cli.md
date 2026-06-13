# CLI

One `plan-loop` bin maps 1:1 onto the four reference scripts. This dispatch is
a deliberate surface adaptation from the reference (an npm package cannot ship
four script names): a first argument of exactly `launch`, `status`, or
`intervene` routes to that entry point; anything else — including any file
path — is the core run. A literal bare `launch`/`status`/`intervene` filename
is shadowed; `./launch` or `launch.md` is not. Within each entry point the
flags, positionals, unknown-flag rejection, and exit codes are identical to
the reference scripts, with one further documented deviation: an explicit
`-h`/`--help` prints usage to **stdout** and exits **0** in every entry point
(the reference run/intervene scripts replied on stderr with exit 1).
Error-path usage output keeps the reference streams and exit codes.
`plan-loop --help` with no other arguments prints the global help
(subcommands, core-run flags, and the effective defaults from the resolved
`plan-loop.json`); `plan-loop --version`/`-V` prints the package version.

ANSI color is emitted only when the target stream is a TTY and `NO_COLOR` is
unset or empty ([no-color.org](https://no-color.org) semantics) — redirected
output and `run.log` stay escape-free; the log text itself is unchanged.
Provider stream logs are metadata-only: tool names, target paths, command and
text sizes, retry/stall markers, status, and counts are logged, but prompt,
plan, source, tool-argument, and raw provider stderr bodies are not mirrored to
normal output. On a non-zero provider exit, `plan-loop` emits one compact
`<role>/<provider> call failed` summary with status, captured stderr line
count, and a classified reason when one is recognized.

## Core run — `plan-loop [flags] <plan.md>`

```text
plan-loop [--iters N] [--effort {low,high,max}] [--no-fix] [--locale LOCALE] [--no-translate] <plan.md>
plan-loop [--iters N] [--effort {low,high,max}] [--no-fix] [--locale LOCALE] [--no-translate] --prompt <prompt.md>
```

Flags accept both `--flag value` and `--flag=value` forms for `--iters` /
`--max-iters`, `--effort`, and `--locale`. `--locale <tag>` selects the
human-interaction locale; when omitted, the locale is `en`. Clarification
questions sent through Telegram use that locale. Non-English locales also run
the non-fatal final localization pass and write `plan.final.<tag>.md`; `en`
keeps the final plan English-only. Unknown flags print `unknown flag:` plus
usage and exit 1. One positional input only.

After the fix pass and before the single `FINAL:` status, a deterministic split
policy (`PLAN_LOOP_SPLIT`, `PLAN_LOOP_SPLIT_MIN_PHASES`, sized by
`PLAN_LOOP_MAX_PLAN_LINES` — see [configuration.md](configuration.md)) records
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
| 143  | TERM/INT teardown                                    |

## `plan-loop launch`

```text
plan-loop launch [--resume] [--iters N] [--effort {low,high,max}] [--prompt] [--no-fix] [--locale LOCALE] [--no-translate] <input.md>
```

Backgrounds the run in its own process group, rotates `run.log`, exports
`CI=true` (and `PLAN_LOOP_RESUME=1` for `--resume`), verifies liveness, and
prints pid/log/work plus follow/stop hints. Usage errors exit 2; resume workdir
resolution exits 3 (none found) or 4 (ambiguous).

## `plan-loop status [PID]`

With a PID — **any** process in the run's tree, including provider children —
walks the parent chain to the root run, resolves its workdir registry-first,
and prints the process tree, artifact counts, an iteration table computed from
the `$WORK` artifacts, interventions, the last log event, and follow/stop
hints. With no arguments, lists every currently running plan-loop run
(registry first, plus a `ps` scan that `PLAN_LOOP_STATUS_SCAN_PS=0` disables).

Exits 2 for an unknown PID, 3 for a live PID outside any plan-loop tree.

POSIX `ps` and `lsof` are the port's deliberate external-binary exceptions
(`lsof` only resolves a run's workdir from its open `run.log` handle); tree,
elapsed, and workdir rendering degrade gracefully without them.

## `plan-loop intervene`

```text
plan-loop intervene --work <workdir> [--target all|critic|creator|fixer|reviewer] <message...>
plan-loop intervene --work <workdir> [--target ...] --stdin
```

Appends `{id, ts, target, message}` to `operator-interventions.jsonl`. Active
entries are injected into the targeted roles' prompts on the next call and
marked migrated once a revision lands. Invalid targets exit 1; a missing
workdir or empty message exits 2.
