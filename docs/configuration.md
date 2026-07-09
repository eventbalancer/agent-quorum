# Configuration

agent-quorum reads one per-user store that the CLI and the library API resolve
identically. Configuration is optional: with no store and no environment, every
setting falls back to a built-in default.

## The store

Two files live under the agent-quorum home (`AGENT_QUORUM_HOME`, default
`~/.agent-quorum`), the same root that anchors `runs/` and `state/`:

| File                  | Holds                            | Permissions              |
| --------------------- | -------------------------------- | ------------------------ |
| `<home>/config.json`  | non-secret operator settings     | home `0700`              |
| `<home>/secrets.json` | credentials (`telegramBotToken`) | file `0600`, home `0700` |

Both the home (`0700`) and `secrets.json` (`0600`) are hardened on **read and
write**: a pre-existing mode looser than the target is repaired before the file
is parsed, so a hand-created `0644` secrets file is tightened rather than
trusted. The home re-harden is conditional and scoped: it runs on a write and on
a genuine secret read (when `secrets.json` exists), only when the directory is
looser than `0700`, so a read-only command (e.g. `agent-quorum config`) pointed
at an `AGENT_QUORUM_HOME` that holds no `secrets.json` leaves the directory's
permissions unchanged, and an already owner-only home is never re-chmodded.
A malformed `config.json`/`secrets.json` halts the run with a controlled error
that names the path only — file contents (and the token) are never echoed.
`config.json` is a partial document; any unset key resolves from the default.
Unknown keys are tolerated. Re-running `agent-quorum setup` deep-merges a minimal
patch into the existing `config.json` rather than replacing it, so operator-tuned
and unknown keys (including hand-edited advanced keys) survive; only the keys
`setup` writes — changed essentials, reassigned role runners, and
`telegram.chatId` — are updated.

## Precedence

Every setting resolves through one uniform precedence:

```
per-invocation override  >  ambient AGENT_QUORUM_* env  >  <home>/config.json  >  built-in default
```

The **override** tier is the per-invocation input: CLI scalar flags
(`--iters`/`--quality`/`--fix`/`--no-fix`/`--translate`/`--no-translate`/`--locale`)
and, for the library API, the structured `config`/`secrets` options. When a
top-level scalar option and the same path in structured `config` are both set,
the **top-level scalar wins** (the intra-override tie-break), identically
in-process and across a detached launch. A few settings have no env layer by
design: `settings.quality` and `settings.fix` come only from the override or the
store, and all tool-permission fields are store-only.

`agent-quorum config` prints the fully resolved configuration and each value's
winning layer (`override`/`env`/`store`/`default`); the bot token is masked.

## Setup

`agent-quorum setup` is the guided way to write the store. It only ever touches
the essentials and the per-role runners; advanced keys (knobs, retention, tool
permissions, …) stay hand-edited and are never discarded.

In an interactive terminal it prompts, each defaulting to the current resolved
value, for `iters`, `quality`, `locale`, and `translate`; then auto-detects the
installed runner CLIs and, per role, keeps the current resolved runner when it is
installed (so a built-in default stays on defaults and a hand-set override is
preserved) or falls back to the first installed runner with its
`RUNNER_META.defaultModel`, letting you confirm or override each; then offers an
optional Telegram step that captures the bot token and discovers the chat id.
When no supported runner is installed it warns with install/login guidance and
leaves the role runners unchanged.

In a non-interactive context it does not block: it applies the same essentials
from `--iters`/`--quality`/`--locale`/`--translate`/`--no-translate`,
auto-assigns role runners by the same preserve-then-fallback rule, and skips
Telegram.

Writes are minimal: a setting is persisted only when it differs from the current
resolved value, and `translate` is written whenever the chosen value contradicts
what the selected `locale` implies — so an explicit `translate: false` under a
non-English locale survives the next resolve. A captured token goes to
`secrets.json` at `0600`.

## Settings reference

Persisted settings live in `config.json` under the keys below. Each may also be
set for one run through its environment variable (when it has one); the listed
default is the built-in fallback.

### Loop settings (`settings`)

| Store key                    | Env var                              | Default    | Meaning                                                              |
| ---------------------------- | ------------------------------------ | ---------- | -------------------------------------------------------------------- |
| `settings.iters`             | `AGENT_QUORUM_MAX_ITERS`             | `5`        | iteration cap (positive integer)                                     |
| `settings.quality`           | _(override/store only; `--quality`)_ | `balanced` | `quick` \| `balanced` \| `thorough`                                  |
| `settings.fix`               | _(override/store only; `--fix`)_     | `true`     | reference fix pass                                                   |
| `settings.translate`         | `AGENT_QUORUM_TRANSLATE`             | `false`    | localized companion plan pass                                        |
| `settings.locale`            | `AGENT_QUORUM_LOCALE`                | `en`       | interaction/companion locale (non-`en` enables translate unless off) |
| `settings.diffThreshold`     | `AGENT_QUORUM_DIFF_THRESHOLD`        | `5`        | stable-diff convergence threshold                                    |
| `settings.retryCount`        | `AGENT_QUORUM_RETRY_COUNT`           | `3`        | provider retry attempts                                              |
| `settings.retryDelaySeconds` | `AGENT_QUORUM_RETRY_DELAY_SECONDS`   | `10`       | delay between retries                                                |

### Role matrix (`roles.<role>`)

Roles: `creator`, `critic`, `fixer`, `reviewer`, `translator`, `judge`. Each
carries `runner` (`codex` \| `claude` \| `cursor`) and `model`, plus
tool-permission fields; the per-role reasoning level is derived from
`settings.quality` at runtime rather than stored per role. `runner`/`model`
accept an env override `AGENT_QUORUM_<ROLE>_RUNNER` / `_MODEL`; tool fields are
store-only and accept a non-empty string or string array (joined with commas).

| Tool field (per role)                                                          | Applies to                             |
| ------------------------------------------------------------------------------ | -------------------------------------- |
| `tools`, `disallowedTools`                                                     | critic/fixer/reviewer/translator/judge |
| `createTools`, `createDisallowedTools`, `updateTools`, `updateDisallowedTools` | creator                                |

Defaults: `creator` = `claude`/`claude-opus-4-8`; `critic` = `codex`/`gpt-5.5`;
`fixer`/`reviewer`/`translator` = `codex`/`gpt-5.5`; `judge` =
`claude`/`claude-opus-4-8`. Read-only roles default to `Read,Grep,Glob` tools
with write/exec/agent tools disallowed.

The creator must return a complete plan in one capture. Reliable minimum creator
tiers: claude opus class (`claude-opus-4-8`; weaker claude needs `default`
permission mode and may still stub), codex `gpt-5.5`, cursor `composer-2.5`.

### Watchdog knobs (`knobs`)

Stream knobs for `knobs.claude` and `knobs.cursor` (env prefix
`AGENT_QUORUM_CLAUDE_` / `AGENT_QUORUM_CURSOR_`):

| Store key                    | Env suffix                      | Default |
| ---------------------------- | ------------------------------- | ------- |
| `stallTimeoutSeconds`        | `STALL_TIMEOUT_SECONDS`         | `600`   |
| `stallPollSeconds`           | `STALL_POLL_SECONDS`            | `5`     |
| `stallInterruptGraceSeconds` | `STALL_INTERRUPT_GRACE_SECONDS` | `20`    |
| `callTimeoutSeconds`         | `CALL_TIMEOUT_SECONDS`          | `1800`  |
| `semanticIdleTimeoutSeconds` | `SEMANTIC_IDLE_TIMEOUT_SECONDS` | `900`   |

Pass knobs for `knobs.fixPass` and `knobs.translatePass` (env prefix
`AGENT_QUORUM_FIX_PASS_` / `AGENT_QUORUM_TRANSLATE_PASS_`): `timeoutSeconds`
(`900`), `semanticIdleTimeoutSeconds` (`900`), `retryCount` (`1`).

### Providers (`providers`)

| Store key                            | Env var                                   | Default        | Meaning                                                                       |
| ------------------------------------ | ----------------------------------------- | -------------- | ----------------------------------------------------------------------------- |
| `providers.livenessHeartbeatSeconds` | `AGENT_QUORUM_LIVENESS_HEARTBEAT_SECONDS` | `30`           | wall-clock liveness line cadence for silent codex/cursor calls (`0` disables) |
| `providers.claudeThinkingEvery`      | `AGENT_QUORUM_CLAUDE_THINKING_LOG_EVERY`  | `3`            | Claude `thinking…` heartbeat cadence                                          |
| `providers.cursorBin`                | `AGENT_QUORUM_CURSOR_BIN`                 | `cursor-agent` | cursor CLI binary                                                             |
| `providers.providerDiagnostics`      | `AGENT_QUORUM_PROVIDER_DIAGNOSTICS`       | `false`        | opt-in raw per-call stdout/stderr capture under `$WORK/diagnostics/`          |
| `claudePermissionMode`               | `CLAUDE_PERMISSION_MODE`                  | `default`      | Claude Code `--permission-mode` for claude-runner roles                       |

The liveness heartbeat never feeds the watchdog stall counters, so it cannot mask
a real stall. `claudePermissionMode`: `default` returns the requested artifact;
`plan` makes Claude Code present a plan (a weak model returns only a stub and
persists the plan under `~/.claude/plans/`, which can fail the CREATE shape gate
with exit 4). The translator role is always `default`. Other Claude Code modes
pass through verbatim but are unsupported.

Provider diagnostics keep the metadata-only log contract: normal logs emit only a
`diagnostics →` reference; raw prompt/plan/source/tool/stderr bodies never reach
standard output. Capture is best-effort and never changes a provider exit code.

#### Claude structured-output compatibility

Claude Code `2.1.205` is the verified structured-output baseline. The canonical
role contracts stay on JSON Schema draft 2019-09 for local validation; immediately
before a Claude JSON-mode invocation, agent-quorum supplies an equivalent,
in-memory draft-07 projection through `--json-schema`. Later Claude Code releases
are supported when they continue to accept that structured-output invocation
contract. This is a compatibility contract, not a version pin or closed version
range: preflight continues to check installation and authentication only and does
not reject a CLI version.

When Claude rejects the schema argument with the recognized deterministic
signature, the normal metadata-only failure summary ends in
`schema-incompatible`. The affected Claude JSON-mode call starts at most one
provider process regardless of `settings.retryCount`; raw stderr remains omitted.
Set `providers.providerDiagnostics` or
`AGENT_QUORUM_PROVIDER_DIAGNOSTICS=1` only when the raw opt-in diagnostic artifact
is needed for deeper troubleshooting.

### Large-plan split (`split`) and status (`status`)

| Store key             | Env var                         | Default | Meaning                                                  |
| --------------------- | ------------------------------- | ------- | -------------------------------------------------------- |
| `split.mode`          | `AGENT_QUORUM_SPLIT`            | `auto`  | `auto` \| `always` \| `never`                            |
| `split.minPhases`     | `AGENT_QUORUM_SPLIT_MIN_PHASES` | `5`     | phase count that triggers an `auto` split                |
| `status.maxPlanLines` | `AGENT_QUORUM_MAX_PLAN_LINES`   | `900`   | plan-size warning threshold and `auto` split size signal |

`auto` emits a navigable `plan.package/` when the converged, post-fix
`plan.final.md` exceeds `status.maxPlanLines` **or** has at least
`split.minPhases` Work Plan phases; `always` forces a package; `never` keeps a
single document. Every run records the decision in `plan.split.json`;
`plan.final.md` stays the entry point. The shared forbidden-shell scan that gates
`plan.final.md` and every `plan.package/*.md` shell block rejects `pnpm -r`,
`pnpm --filter`, `npx `, `git commit`, `git push`, `git pull`, `git reset --hard`,
and `git checkout --`.

### Retention (`retention`)

| Store key              | Env var                     | Default | Meaning                                     |
| ---------------------- | --------------------------- | ------- | ------------------------------------------- |
| `retention.keepCount`  | `AGENT_QUORUM_RETAIN_COUNT` | `50`    | terminal records `prune` keeps              |
| `retention.maxAgeDays` | `AGENT_QUORUM_RETAIN_DAYS`  | `30`    | terminal records older than this are pruned |

Retention is record-only; functional workdirs are never deleted.

### Telegram (`telegram`) and secrets

The bot token is the only secret: it lives in `<home>/secrets.json` as
`telegramBotToken`, or arrives via the env layer / structured `secrets`. The
remaining Telegram settings are non-secret and live under `telegram` in
`config.json`.

| Store key                              | Env var                                                | Default  | Meaning                                            |
| -------------------------------------- | ------------------------------------------------------ | -------- | -------------------------------------------------- |
| `secrets.telegramBotToken`             | `AGENT_QUORUM_TELEGRAM_BOT_TOKEN`                      | _(none)_ | bot token (in `secrets.json`, never `config.json`) |
| `telegram.chatId`                      | `AGENT_QUORUM_TELEGRAM_CHAT_ID`                        | _(none)_ | numeric chat id                                    |
| `telegram.clarify`                     | `AGENT_QUORUM_CLARIFY`                                 | `auto`   | `1` on, `0` off, `auto` (on when configured)       |
| `telegram.clarifyDeadlineSeconds`      | `AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS`                | `86400`  | max total wait for answers                         |
| `telegram.pollTimeoutSeconds`          | `AGENT_QUORUM_TELEGRAM_POLL_TIMEOUT`                   | `50`     | long-poll seconds per getUpdates                   |
| `telegram.httpTimeoutSeconds`          | `AGENT_QUORUM_TELEGRAM_HTTP_TIMEOUT`                   | `70`     | HTTP timeout seconds                               |
| `telegram.receiveFailureWindowSeconds` | `AGENT_QUORUM_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS` | `120`    | receive-failure window before exit 8               |
| `telegram.receiveBackoffSeconds`       | `AGENT_QUORUM_TELEGRAM_RECEIVE_BACKOFF_SECONDS`        | `2`      | initial receive retry backoff (capped at 30)       |

A bot token plus chat id enables best-effort completion notifications and the
prompt-mode clarification gate (unless `clarify` is off). Multiple prompt-mode
runs can share one bot and chat; questions correlate by Telegram reply-to
metadata. A persistent unauthorized token, network/timeout failure, or
`getUpdates` 409 conflict exits with code 8.

## Library API

`runPlanLoop`/`launchPlanLoop` accept structured `config?: DeepPartial<OperatorConfig>`
and `secrets?: { telegramBotToken?: string }` (plus `home`/`workDir`) as typed
options — no `process.env` mutation by the caller. In-process these fold directly
into the resolver. A detached `launchPlanLoop` forwards the non-secret config to
the child as JSON and the effective bot token (the structured override, else the
parent's ambient `AGENT_QUORUM_TELEGRAM_BOT_TOKEN`) through an owner-only `0600`
handoff file under `<home>/handoff/` — only the file path is passed, the ambient
token is stripped from the child env, and the child reads the file once and
unlinks it before any provider subprocess starts. The bot token never enters the
child or provider-subprocess environment. The forwarded path must resolve to a
regular file strictly inside `<home>/handoff/`; anything else (an out-of-dir
path, the handoff directory itself, a sub-directory) fails as a controlled error
before any read or unlink. The handoff is normally consumed within ~1s; should a
child die after the parent's liveness check but before reading, the stale file
is garbage-collected lazily — each detached launch sweeps `<home>/handoff/`
entries older than a few minutes, so an orphaned token cannot linger.
Store/discovery helpers
(`readConfigStore`/`writeConfigStore`/`readSecretsStore`/`writeSecretsStore`,
`telegramDiscoverChatId`) are exported for embedded onboarding. See
[`api.md`](api.md).

## Artifact roots

| Variable                 | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `AGENT_QUORUM_HOME`      | artifact + store root (default `~/.agent-quorum`)             |
| `AGENT_QUORUM_WORK_DIR`  | explicit workdir (default `<home>/runs/loop-<name>`)          |
| `AGENT_QUORUM_PLANS_DIR` | functional runs root (default `<home>/runs`; legacy override) |
| `AGENT_QUORUM_STATE_DIR` | system ledger dir (default `<home>/state`; legacy override)   |
| `AGENT_QUORUM_RESUME`    | `1` resumes from the last stable plan                         |

The default root splits **functional** output (`<home>/runs/loop-<name>`) from
the **system** ledger (`<home>/state/runs/<runId>.json`). The no-argument
`status` listing and `listRuns` read across all known stores (the ambient
`STATE_DIR`/`PLANS_DIR`-derived store, `<home>/state`, and the project-local
`<cwd>/.agents/plans/.runs`), deduped and read-only; scope to one with
`--store <dir>` (CLI) or `{ store }` (library).

## Env-only rendezvous and timing variables (not persisted)

These never live in the store; they are runtime rendezvous points or timing knobs
sourced from the environment (or a built-in default):

| Variable                           | Default                    | Meaning                                          |
| ---------------------------------- | -------------------------- | ------------------------------------------------ |
| `AGENT_QUORUM_TELEGRAM_API_BASE`   | `https://api.telegram.org` | Bot API base override (tests inject a stub)      |
| `AGENT_QUORUM_TELEGRAM_STATE_DIR`  | `os.tmpdir()`              | shared clarify-broker state root                 |
| `AGENT_QUORUM_LAUNCH_VERIFY_DELAY` | `1`                        | seconds before the launch liveness check         |
| `AGENT_QUORUM_STATUS_SCAN_PS`      | _(on)_                     | `0` disables the `ps` scan in the status listing |

The clarification broker stores coordination files under
`<state-root>/agent-quorum/telegram/<token-chat-hash>/` (`0700` dir, `0600`
files); it is compacted and removed when the last live run for that bot and chat
exits.

## Obsolete

`AGENT_QUORUM_AJV_BIN` selected the validator binary in the reference; schema
validation now runs in-process, so a set value is warned once and ignored.
