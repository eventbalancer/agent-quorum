# Run lifecycle

Every agent-quorum run is addressable for its whole life — start, observe, inspect,
intervene, stop — from both the CLI and the library, using one selector grammar.
This page walks the five stages end to end. For the full flag reference see
[`cli.md`](cli.md); for the typed surface see [`api.md`](api.md).

In a dual-TTY terminal, bare `agent-quorum` opens the
[local web workspace](web-workspace.md); run-lifecycle operations remain on the
explicit CLI commands and the API this page describes.

## Identity and selectors

At start each run mints a sortable, non-digit-leading `runId` (shape
`r<base36-ts>-<hex>`) and a `name` (the input base, disambiguated to
`name-2`/`name-3` when an earlier run still holds the bare name). Every start
surface reports them — the `run <id> (<name>)` log line, the `launch` `run:`
block, and `RunResult`/`LaunchResult`.

`show`, `logs`, `intervene`, and `status --watch` (CLI) and
`getRun`/`getRunLogPath`/`interveneRun` (API) accept one selector grammar:

- a bare all-digits token is a **pid** (any process in the run's tree) and
  resolves a **live run only** — a finished run's pid is gone;
- a `runId` or an unambiguous prefix resolves that exact run;
- any other token is a **name**, resolving the most-recent run with that name
  (an older same-named run stays reachable by its `runId`);
- `--last` resolves the most-recent run overall; `--work <dir>` addresses an
  explicit workdir without consulting the ledger.

Artifacts live under `~/.agent-quorum` by default: functional output in
`runs/loop-<name>/` and the durable per-run ledger in `state/runs/<runId>.json`
(see [`configuration.md`](configuration.md) for `AGENT_QUORUM_HOME` and the
overrides). The library lookups also take a `home` option to read a custom root
without mutating the environment.

## 1. Start

CLI — foreground core run, or a detached background run:

```sh
agent-quorum plan my-plan.md               # run in the foreground; logs to stderr
agent-quorum plan --prompt my-task.md      # create plan.v0 from a prompt first
agent-quorum launch --quality balanced task.md  # detach into its own process group
```

A foreground run logs `run <id> (<name>)` at start and writes `run.log` in its
workdir. `launch` prints a `started:` block with the `run:` id, `pid`, `log`,
and `work` paths, then returns immediately. Because `launch` puts the run in its
own process group with `detached: true` (a new session, cross-platform on macOS
and Linux without the `setsid` binary), the run survives the terminal — or the
Claude Code session — that started it being closed; follow and stop it later
with the printed commands.

Without the `launch` command — for example a manual operator run from a plain
shell — wrap the foreground `plan` so it detaches the same way. This works on
macOS (no `setsid`) and Linux:

```sh
( nohup agent-quorum plan task.md > task.run.log 2>&1 & )   # detached; ignores SIGHUP on close
```

The subshell plus `nohup` keeps the run alive after the launching shell exits;
inspect `task.run.log` for progress and outcome.

API — the same two entry points; both report `runId`/`name`:

```ts
const result = await runPlanLoop({ input: 'my-plan.md', quality: 'balanced' });
// result.runId, result.name, result.workDir, result.finalPlanPath, …

const launched = await launchPlanLoop({ input: 'task.md' });
// launched.runId, launched.name, launched.pid, launched.logPath, launched.workDir
```

## 2. Observe

Follow a run's log by selector (pure Node; no external `tail`):

```sh
agent-quorum logs my-plan          # print run.log
agent-quorum logs --last -f        # follow the most-recent run until it ends
```

`-f`/`--follow` streams appended lines until the run reaches a terminal state.
A run that streamed to its console (rather than a redirected `run.log`) has no
log file; `logs` then prints a one-line message pointing at the workdir and
exits 0 instead of hanging. The API counterpart is `getRunLogPath(selector)`,
which returns the `run.log` path when it exists, else `undefined`.

`show` prints a run's resolved artifact paths and state:

```sh
agent-quorum show --last           # workdir + plan.final.md / summary.md / run.log + state
```

## 3. Status

```sh
agent-quorum status                # TTY: pick from live-first + recent-finished runs
                                # non-TTY: a scriptable listing; never blocks
agent-quorum status <PID>          # the run owning any PID in its process tree
agent-quorum status --watch --last # re-render until the run ends (one snapshot non-TTY)
```

The no-arg listing aggregates the known durable ledger stores (ambient state,
`<home>/state`, the legacy plans-derived store, and the project-local
`.agents/plans/.runs` self-planning store). A record is live only when its pid is
alive with a matching pgid and start token, so a recycled pid never masquerades
as a live run. Pass `--store <dir>` to scope the listing to one ledger. The API
exposes the same data without blocking:

```ts
const runs = listRuns(); // RunRecord[] across all known stores
const scoped = listRuns({ store: '.agents/plans/.runs' }); // one ledger only
const run = getRun('my-plan'); // by name, runId/prefix, or { kind: 'last' }
const snapshot = getRunStatus(pid); // { exitCode, output }; no-arg returns the listing
```

## 4. Intervene

Append operator guidance to a run's ledger; the targeted roles pick it up on
their next call:

```sh
agent-quorum intervene --last "prefer the staged rollout"
agent-quorum intervene my-plan --target creator "use the existing retry helper"
agent-quorum intervene --work /abs/path/loop-my-plan "..."   # explicit workdir
```

The workdir comes from `--work` or, when absent, from the selector. The API
mirrors this:

```ts
interveneRun('my-plan', 'prefer the staged rollout', 'creator');
addIntervention('/abs/path/loop-my-plan', '...'); // unchanged workdir-first form
```

## 5. Stop

A run owns its process group; `status`/`launch` print the stop hint:

```sh
kill -TERM -<pgid>   # terminate the whole run process group (status/launch print this)
```

On teardown the run finalizes its `state/runs/<runId>.json` record. A
hard-killed run that never finalized is still classified correctly on the next
`status`/`list` — its record is inferred terminal (`finished` if `plan.final.md`
landed, else `failed`) once its pid is no longer live.

## Retention

The ledger self-bounds: each run prunes terminal records beyond the retention
window at start, and `agent-quorum prune` (API `pruneRuns`) does it on demand.
Pruning removes ledger records only — functional workdirs are never deleted.

```sh
agent-quorum prune --keep 50 --dry-run   # report what would be removed
```
