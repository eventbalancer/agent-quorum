# Interactive shell

`agent-quorum` with no command, in a terminal where **both** stdin and stdout are
TTYs, opens a full-screen, keyboard-first shell over the existing run lifecycle.
It is a thin render/state layer over the same engines the CLI uses — discovery,
detailed status, `run.log` tailing, launch, intervene, and stop — built only on
`node:readline` raw-mode keypresses and raw ANSI, with no new dependency.

In any non-interactive context (piped or redirected stdio) or with `--help`/`-h`,
the same no-argument invocation prints the [global help](cli.md) instead; this
runbook covers only the dual-TTY shell.

Opening the shell performs **no mutation**: it reads ledger and artifact metadata
and starts a read-only refresh timer. The only write paths are launch, intervene,
and a typed-name-confirmed stop — each behind an explicit operator action.

## Open

```sh
agent-quorum
```

The shell enters the alternate screen, hides the cursor, and shows the
**Dashboard**. On exit (quit, `Ctrl-C`, or an input-stream end) it restores the
cursor and the primary screen and exits 0.

## Views and keys

Global, outside text editing: `↑`/`↓` or `j`/`k` move · `Enter` select/submit ·
`b` back · `r` refresh · `q` quit · `?` help. Always: `Ctrl-C` quits in any
context; `Esc` is back/cancel.

### Dashboard

Runs are grouped by their canonical run store (project-local
`.agents/plans/.runs`, `<home>/state`, and ambient/legacy stores), deduping
alias/symlinked stores and applying the same global retention cap the run listing
uses, so the dashboard never grows past what retention keeps. Live runs sort
first within each group. Each row shows the run name, state, short run id,
start/end time, and workdir.

| Key              | Action                          |
| ---------------- | ------------------------------- |
| `j`/`k`, `↑`/`↓` | Move the cursor                 |
| `Enter`          | Open the highlighted run detail |
| `n`              | Open the launch form            |
| `r`              | Refresh now                     |
| `q`              | Quit                            |

### Run detail

`Enter` on a run opens its detail: record header, artifact presence
(`plan.final.md`, `summary.md`), iteration count, operator-intervention status,
and the latest `run.log` event. For a live run the process tree and iteration
table are captured from the detailed status engine; when the pid is gone (a
dead-pid race) or `ps`/`lsof` are unavailable, process info is shown as
unavailable and any stray engine stderr is contained — it never reaches the
screen.

| Key       | Action                     |
| --------- | -------------------------- |
| `l`       | Follow the run's `run.log` |
| `i`       | Open the intervention form |
| `s`       | Open the stop confirmation |
| `r`       | Reload the detail          |
| `b`/`Esc` | Back to the dashboard      |
| `q`       | Quit                       |

### Logs

`l` opens a cancellable tail of `run.log`. The header shows `following` while the
run is live and `stopped (terminal)` once it reaches a terminal state — at which
point the poll drains the final bytes and stops on its own. A run that streamed
to its console (no `run.log`) shows a `no run.log` marker rather than an error.

| Key       | Action                              |
| --------- | ----------------------------------- |
| `b`/`Esc` | Stop following and return to detail |
| `q`       | Quit                                |

### Launch form (`n`)

Fields, navigated with `Tab`/`↑`/`↓`:

| Field       | Type          | Notes                                                          |
| ----------- | ------------- | -------------------------------------------------------------- |
| `input`     | text          | Required: a readable plan or prompt file.                      |
| `mode`      | toggle        | `plan` (positional) vs `prompt` (`--prompt`).                  |
| `resume`    | toggle        | `--resume`; the input is still required.                       |
| `iters`     | text (digits) | `--iters N`; blank keeps the engine/config default.            |
| `effort`    | cycle         | `default`→`low`→`high`→`max`; `default` omits `--effort`.      |
| `fix`       | tri-state     | `default` (omit) / `on` (`--fix`) / `off` (`--no-fix`).        |
| `locale`    | text          | `--locale <tag>`; blank omits it (engine resolves the locale). |
| `translate` | tri-state     | `default` (omit) / `on` / `off`.                               |

`Space` toggles a boolean/tri-state field; `←`/`→` (or `Space`) cycles `effort`.
`Enter` submits. The form prevalidates the input (present, a real file) and
`iters` before invoking the engine; an invalid field keeps the form open with a
status message. On success the new (or resumed) run's identity is shown and the
dashboard reloads so the run appears.

### Intervention form (`i`)

`Tab` moves between the `target` (cycled through
`all`/`critic`/`creator`/`fixer`/`reviewer` with `Space`/`←`/`→`) and the
`message` text field. `Enter` appends a `{id, ts, target, message}` line to the
run's `operator-interventions.jsonl`, identical to `agent-quorum intervene`.

### Stop confirmation (`s`)

The stop view names the specific run and its `kill -TERM -<pgid>` affordance and
asks you to type the run's **name** to confirm. On an exact match, liveness is
re-resolved immediately before signaling — a recycled pid/pgid or an
already-terminal run is never signaled — and the run's process group is sent
`SIGTERM`. A typed name that does not match, a run that is no longer live, or a
failed `kill` surfaces as a status and leaves the shell open. `Esc` cancels.

## Refresh, color, and size

- A read-only refresh tick reloads the dashboard periodically without leaving the
  current view; `r` refreshes on demand.
- Color follows the active output stream: it is emitted only when stdout is a TTY
  and `NO_COLOR` is unset or empty ([no-color.org](https://no-color.org)). With
  color off, the rendered frame — including any captured engine block — is
  ANSI-stripped, so the shell's color flag is authoritative.
- The layout targets an 80×24 viewport and adapts to the terminal's reported
  columns/rows, re-rendering on resize.

## Quit

`q` (outside text editing) or `Ctrl-C` (any context) tears down the shell:
timers and the log-follow poll are cleared, raw mode and the cursor are restored,
the alternate screen is exited, and the process returns 0.
