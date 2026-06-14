# Configuration

## agent-quorum.json

One fixed config file at the package root; `AGENT_QUORUM_CONFIG_FILE` overrides
the path (there is no search chain). Missing required fields halt the run with
a controlled error; unknown keys warn and are ignored.

```jsonc
{
  "version": 1,
  "settings": {
    "iters": 7,              // iteration cap (required)
    "effort": "high",        // low | high | max (required)
    "fix": true,             // reference fix pass (required)
    "locale": "en",          // human interaction locale (optional, default en)
    "translate": false,      // compatibility translate-pass toggle (optional)
    "diffThreshold": 5,      // stable-diff convergence threshold (required)
    "retryCount": 3,         // provider retry attempts (required)
    "retryDelaySeconds": 10  // delay between retries (required)
  },
  "roles": {
    "critic":     { "runner": "claude", "model": "…", "reasoning": "…", "tools": [...], "disallowedTools": [...] },
    "creator":    { "runner": "claude", "model": "…", "reasoning": "…",
                    "createTools": [...], "createDisallowedTools": [...],
                    "updateTools": [...], "updateDisallowedTools": [...] },
    "fixer":      { ... },
    "reviewer":   { ... },
    "translator": { ... }
  }
}
```

Runner whitelist: `codex`, `claude`, `cursor`. Tool fields accept a non-empty
string or a non-empty string array (joined with commas).

### Precedence

- Loop settings: `CLI > env > file`. `locale` defaults to `en`; non-English
  locales enable the localized final companion plan unless `translate` is
  explicitly off. `effort` and `fix` deliberately have no env layer
  (`--effort`/`--fix`/`--no-fix` or the file).
- Role matrix (`runner`/`model`/`reasoning`): `env > file`.
- Tool permissions: file only.

## .env

A gitignored `.env` at the **package root** loads unconditionally before any
config resolution, with real-environment-wins semantics. A `.env` sitting next
to a `AGENT_QUORUM_CONFIG_FILE` override is never read. Intended for the Telegram
secrets and other local credentials.

## Environment variables

### Run placement

| Variable                    | Meaning                                                       |
| --------------------------- | ------------------------------------------------------------- |
| `AGENT_QUORUM_CONFIG_FILE`  | config file override                                          |
| `AGENT_QUORUM_HOME`         | artifact root (default `~/.agent-quorum`)                     |
| `AGENT_QUORUM_WORK_DIR`     | explicit workdir (default `<home>/runs/loop-<name>`)          |
| `AGENT_QUORUM_PLANS_DIR`    | functional runs root (default `<home>/runs`; legacy override) |
| `AGENT_QUORUM_STATE_DIR`    | system ledger dir (default `<home>/state`; legacy override)   |
| `AGENT_QUORUM_RETAIN_COUNT` | prune keeps this many terminal records (default 50)           |
| `AGENT_QUORUM_RETAIN_DAYS`  | prune drops terminal records older than this (default 30)     |
| `AGENT_QUORUM_RESUME`       | `1` resumes from the last stable plan                         |

The default root splits **functional** output (`<home>/runs/loop-<name>`, the
per-run workdirs holding `plan.final.md`/`summary.md`/`run.log`) from the
**system** ledger (`<home>/state/runs/<runId>.json`, the durable run records).
A clean install writes nothing under `~/.claude`; there is no migration of
pre-existing `~/.claude/plans` trees (setting `AGENT_QUORUM_HOME=$HOME/.claude/plans`
recreates the old location if needed). Setting only `AGENT_QUORUM_PLANS_DIR` keeps
the legacy single-var layout (`<plans>/.runs` for state).

The library API additionally accepts `home`/`workDir`/`configFile` as typed
options on `runPlanLoop`/`launchPlanLoop`, and a `home` lookup option on
`listRuns`/`getRun`/`getRunLogPath`/`interveneRun`/`pruneRuns`; resolution
precedence is option > env > default. The CLI contract stays env-first
([details](api.md)).

### Loop settings (env layer)

`AGENT_QUORUM_MAX_ITERS`, `AGENT_QUORUM_DIFF_THRESHOLD`, `AGENT_QUORUM_RETRY_COUNT`,
`AGENT_QUORUM_RETRY_DELAY_SECONDS`, `AGENT_QUORUM_LOCALE`, `AGENT_QUORUM_TRANSLATE`,
`AGENT_QUORUM_MAX_PLAN_LINES` (plan-size warning threshold and split size signal,
default 900).

### Large-plan split policy (env layer)

`AGENT_QUORUM_SPLIT` (`auto` | `always` | `never`, default `auto`) and
`AGENT_QUORUM_SPLIT_MIN_PHASES` (default 5) decide whether a converged, post-fix
`plan.final.md` is additionally emitted as a navigable `plan.package/` (index,
master plan, self-contained phase docs, journal, runbook, debt ledger):

- `auto` splits when the plan exceeds `AGENT_QUORUM_MAX_PLAN_LINES` **or** has at
  least `AGENT_QUORUM_SPLIT_MIN_PHASES` Work Plan phases.
- `always` forces a package regardless of size.
- `never` keeps a single document and records an explicit no-split rationale in
  `plan.split.json`, even above the size signal.

These are env-only (no `agent-quorum.json` settings layer), mirroring
`AGENT_QUORUM_MAX_PLAN_LINES`. Every run records the decision, rationale, and
signals in `plan.split.json`; `plan.final.md` stays the entry point and the
package (when present) shares one combined final status with it. An optional
advisory `effort.md` may accompany a package; it never affects validation.

The shared forbidden-shell scan that gates `plan.final.md` and every
`plan.package/*.md` shell block rejects `pnpm -r`, `pnpm --filter`, `npx `,
`git commit`, `git push`, `git pull`, and the destructive `git reset --hard` and
`git checkout --` (aligned with the repo no-destructive-git rule).

### Role matrix overrides

`AGENT_QUORUM_<ROLE>_RUNNER`, `AGENT_QUORUM_<ROLE>_MODEL`,
`AGENT_QUORUM_<ROLE>_REASONING` for `CRITIC`, `CREATOR`, `FIXER`, `REVIEWER`,
`TRANSLATOR`.

### Watchdog knobs

Claude: `AGENT_QUORUM_CLAUDE_STALL_TIMEOUT_SECONDS` (600),
`AGENT_QUORUM_CLAUDE_STALL_POLL_SECONDS` (5),
`AGENT_QUORUM_CLAUDE_STALL_INTERRUPT_GRACE_SECONDS` (20),
`AGENT_QUORUM_CLAUDE_CALL_TIMEOUT_SECONDS` (1800),
`AGENT_QUORUM_CLAUDE_SEMANTIC_IDLE_TIMEOUT_SECONDS` (900),
`AGENT_QUORUM_CLAUDE_THINKING_LOG_EVERY` (3).

Cursor: the same five knobs with the `AGENT_QUORUM_CURSOR_` prefix, plus
`AGENT_QUORUM_CURSOR_BIN` (default `cursor-agent`).

Passes: `AGENT_QUORUM_FIX_PASS_TIMEOUT_SECONDS` (900),
`AGENT_QUORUM_FIX_PASS_SEMANTIC_IDLE_TIMEOUT_SECONDS` (900),
`AGENT_QUORUM_FIX_PASS_RETRY_COUNT` (1), and the `AGENT_QUORUM_TRANSLATE_PASS_*`
equivalents.

### Provider diagnostics (env layer)

`AGENT_QUORUM_PROVIDER_DIAGNOSTICS=1` enables opt-in raw capture of each provider
call's stdout and stderr into `$WORK/diagnostics/` as
`<seq>-<role>-<provider>.log` files. Normal logs still follow the metadata-only
contract and emit only a `diagnostics →` reference line per call; raw prompt,
plan, source, tool-argument, and stderr bodies never reach standard output.
Capture is best-effort — a filesystem failure disables the sink for that call
with one bounded warning and does not change the provider exit code. Default is
off (unset or any value other than `1`).

### Clarification gate / Telegram

`AGENT_QUORUM_TELEGRAM_BOT_TOKEN` plus `AGENT_QUORUM_TELEGRAM_CHAT_ID` enable
best-effort final completion notifications for core runs automatically. The
same credentials also enable the prompt-mode clarification gate unless
`AGENT_QUORUM_CLARIFY=0` disables that gate; setting `AGENT_QUORUM_CLARIFY=0` does
not disable completion notifications.

Multiple prompt-mode runs can share one bot token and chat. Each question is
correlated by Telegram reply-to metadata, so reply directly to the question
message when more than one run is active in the chat. Plain, untargeted replies
are accepted only when a single live run is using that bot and chat.

Receive-side Telegram failures are surfaced separately from operator
cancellation: a persistent unauthorized token, network/timeout failure, or
`getUpdates` conflict exits with code 8. A persistent 409 conflict names the
concurrent `getUpdates` consumer class in the diagnostic.

| Variable                                               | Meaning                                                                       |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `AGENT_QUORUM_CLARIFY`                                 | `1` force on, `0` force off, `auto` (default: on when Telegram is configured) |
| `AGENT_QUORUM_TELEGRAM_BOT_TOKEN`                      | bot token (secret — keep in `.env`)                                           |
| `AGENT_QUORUM_TELEGRAM_CHAT_ID`                        | numeric chat id                                                               |
| `AGENT_QUORUM_TELEGRAM_API_BASE`                       | Bot API base override (tests inject a stub)                                   |
| `AGENT_QUORUM_TELEGRAM_STATE_DIR`                      | shared broker state root (`os.tmpdir()` by default)                           |
| `AGENT_QUORUM_TELEGRAM_POLL_TIMEOUT`                   | long-poll seconds per getUpdates (50)                                         |
| `AGENT_QUORUM_TELEGRAM_HTTP_TIMEOUT`                   | HTTP timeout seconds (70)                                                     |
| `AGENT_QUORUM_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS` | receive failure window before exit 8 (120)                                    |
| `AGENT_QUORUM_TELEGRAM_RECEIVE_BACKOFF_SECONDS`        | initial receive retry backoff seconds (2, exponential capped at 30)           |
| `AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS`                | max total wait for answers (86400)                                            |

The clarification broker stores shared coordination files under
`<state-root>/agent-quorum/telegram/<token-chat-hash>/`. The directory is `0700`,
files are `0600`, and the journal can contain operator reply text. It is
compacted below the minimum live run cursor and removed when the last live run
for that bot and chat exits.

### Status / launch

`AGENT_QUORUM_STATUS_SCAN_PS` (`0` disables the `ps` scan in the no-argument
status listing), `AGENT_QUORUM_LAUNCH_VERIFY_DELAY` (seconds before the launch
liveness check, default 1).

### Obsolete

`AGENT_QUORUM_AJV_BIN` selected the validator binary in the reference; schema
validation now runs in-process, so a set value is warned once and ignored.
