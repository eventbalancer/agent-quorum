# Configuration

## plan-loop.json

One fixed config file at the package root; `PLAN_LOOP_CONFIG_FILE` overrides
the path (there is no search chain). Missing required fields halt the run with
a controlled error; unknown keys warn and are ignored.

```jsonc
{
  "version": 1,
  "settings": {
    "iters": 7,              // iteration cap (required)
    "effort": "high",        // low | high | max (required)
    "fix": true,             // reference fix pass (required)
    "translate": true,       // russian companion plan (optional, default true)
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

- Loop settings: `CLI > env > file`. `effort` and `fix` deliberately have no
  env layer (`--effort`/`--fix`/`--no-fix` or the file).
- Role matrix (`runner`/`model`/`reasoning`): `env > file`.
- Tool permissions: file only.

## .env

A gitignored `.env` at the **package root** loads unconditionally before any
config resolution, with real-environment-wins semantics. A `.env` sitting next
to a `PLAN_LOOP_CONFIG_FILE` override is never read. Intended for the Telegram
secrets.

## Environment variables

### Run placement

| Variable                | Meaning                                          |
| ----------------------- | ------------------------------------------------ |
| `PLAN_LOOP_CONFIG_FILE` | config file override                             |
| `PLAN_LOOP_WORK_DIR`    | explicit workdir (default `<plans>/loop-<base>`) |
| `PLAN_LOOP_PLANS_DIR`   | plans root (default `~/.claude/plans`)           |
| `PLAN_LOOP_STATE_DIR`   | run registry dir (default `<plans>/.runs`)       |
| `PLAN_LOOP_RESUME`      | `1` resumes from the last stable plan            |

### Loop settings (env layer)

`PLAN_LOOP_MAX_ITERS`, `PLAN_LOOP_DIFF_THRESHOLD`, `PLAN_LOOP_RETRY_COUNT`,
`PLAN_LOOP_RETRY_DELAY_SECONDS`, `PLAN_LOOP_TRANSLATE`,
`PLAN_LOOP_MAX_PLAN_LINES` (plan-size warning threshold, default 900).

### Role matrix overrides

`PLAN_LOOP_<ROLE>_RUNNER`, `PLAN_LOOP_<ROLE>_MODEL`,
`PLAN_LOOP_<ROLE>_REASONING` for `CRITIC`, `CREATOR`, `FIXER`, `REVIEWER`,
`TRANSLATOR`.

### Watchdog knobs

Claude: `PLAN_LOOP_CLAUDE_STALL_TIMEOUT_SECONDS` (600),
`PLAN_LOOP_CLAUDE_STALL_POLL_SECONDS` (5),
`PLAN_LOOP_CLAUDE_STALL_INTERRUPT_GRACE_SECONDS` (20),
`PLAN_LOOP_CLAUDE_CALL_TIMEOUT_SECONDS` (1800),
`PLAN_LOOP_CLAUDE_SEMANTIC_IDLE_TIMEOUT_SECONDS` (900),
`PLAN_LOOP_CLAUDE_THINKING_LOG_EVERY` (25).

Cursor: the same five knobs with the `PLAN_LOOP_CURSOR_` prefix, plus
`PLAN_LOOP_CURSOR_BIN` (default `cursor-agent`).

Passes: `PLAN_LOOP_FIX_PASS_TIMEOUT_SECONDS` (900),
`PLAN_LOOP_FIX_PASS_SEMANTIC_IDLE_TIMEOUT_SECONDS` (900),
`PLAN_LOOP_FIX_PASS_RETRY_COUNT` (1), and the `PLAN_LOOP_TRANSLATE_PASS_*`
equivalents.

### Clarification gate / Telegram

| Variable                             | Meaning                                                                       |
| ------------------------------------ | ----------------------------------------------------------------------------- |
| `PLAN_LOOP_CLARIFY`                  | `1` force on, `0` force off, `auto` (default: on when Telegram is configured) |
| `PLAN_LOOP_TELEGRAM_BOT_TOKEN`       | bot token (secret — keep in `.env`)                                           |
| `PLAN_LOOP_TELEGRAM_CHAT_ID`         | numeric chat id                                                               |
| `PLAN_LOOP_TELEGRAM_API_BASE`        | Bot API base override (tests inject a stub)                                   |
| `PLAN_LOOP_TELEGRAM_POLL_TIMEOUT`    | long-poll seconds per getUpdates (50)                                         |
| `PLAN_LOOP_TELEGRAM_HTTP_TIMEOUT`    | HTTP timeout seconds (70)                                                     |
| `PLAN_LOOP_CLARIFY_DEADLINE_SECONDS` | max total wait for answers (86400)                                            |

### Status / launch

`PLAN_LOOP_STATUS_SCAN_PS` (`0` disables the `ps` scan in the no-argument
status listing), `PLAN_LOOP_LAUNCH_VERIFY_DELAY` (seconds before the launch
liveness check, default 1).

### Obsolete

`PLAN_LOOP_AJV_BIN` selected the validator binary in the reference; schema
validation now runs in-process, so a set value is warned once and ignored.
