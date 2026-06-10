# CLI

One `plan-loop` bin maps 1:1 onto the four reference scripts. This dispatch is
the single deliberate surface adaptation from the reference (an npm package
cannot ship four script names): a first argument of exactly `launch`, `status`,
or `intervene` routes to that entry point; anything else — including any file
path — is the core run. A literal bare `launch`/`status`/`intervene` filename
is shadowed; `./launch` or `launch.md` is not. Within each entry point the
flags, positionals, unknown-flag rejection, and exit codes are identical to the
reference scripts.

## Core run — `plan-loop [flags] <plan.md>`

```text
plan-loop [--iters N] [--effort {low,high,max}] [--no-fix] [--no-translate] <plan.md>
plan-loop [--iters N] [--effort {low,high,max}] [--no-fix] [--no-translate] --prompt <prompt.md>
```

Flags accept both `--flag value` and `--flag=value` forms for `--iters` /
`--max-iters` and `--effort`. Unknown flags print `unknown flag:` plus usage
and exit 1. One positional input only.

Exit codes:

| Code | Meaning                                              |
| ---- | ---------------------------------------------------- |
| 0    | converged — clean or needs-review (see `summary.md`) |
| 1    | usage error or failed preflight                      |
| 3    | schema-invalid critique / update / update metadata   |
| 4    | empty or shape-broken creator output; resume failure |
| 5    | workspace-rule violation in the final plan           |
| 6    | final plan blocked (broken document shape)           |
| 7    | clarification gate cancelled or failed               |
| 143  | TERM/INT teardown                                    |

## `plan-loop launch`

```text
plan-loop launch [--resume] [--iters N] [--effort {low,high,max}] [--prompt] [--no-fix] [--no-translate] <input.md>
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

POSIX `ps` is the port's one deliberate external-binary exception, used only
here; tree and elapsed rendering degrade gracefully without it.

## `plan-loop intervene`

```text
plan-loop intervene --work <workdir> [--target all|critic|creator|fixer|reviewer] <message...>
plan-loop intervene --work <workdir> [--target ...] --stdin
```

Appends `{id, ts, target, message}` to `operator-interventions.jsonl`. Active
entries are injected into the targeted roles' prompts on the next call and
marked migrated once a revision lands. Invalid targets exit 1; a missing
workdir or empty message exits 2.
