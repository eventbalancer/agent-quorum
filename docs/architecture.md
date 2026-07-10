# Architecture

## Roles and providers

Six roles drive the loop, each resolved to a provider through the per-user
config store (`override > env > store > default` per field):

| Role       | Purpose                                                                       | Mode                    |
| ---------- | ----------------------------------------------------------------------------- | ----------------------- |
| critic     | finds issues in the current plan                                              | JSON (critique schema)  |
| creator    | creates plan.v0 and applies critique verdicts                                 | markdown + JSON         |
| fixer      | proposes/applies reference fixes after convergence                            | markdown                |
| reviewer   | reviews the fixer's proposal                                                  | JSON (review schema)    |
| translator | renders the localized companion plan                                          | markdown                |
| judge      | evaluates intermediate and canonical final readiness (balanced/thorough only) | JSON (readiness schema) |

Three provider adapters share one entry point (`providerRun`) that owns the
single retry wrapper:

- **codex** — stateless `codex exec --sandbox read-only` with `--output-schema`;
  markdown-mode roles go through a `plan_markdown` wrapper schema.
- **claude** — `claude -p --verbose --output-format stream-json` with
  `--append-system-prompt`, `--permission-mode default` (overridable via
  `CLAUDE_PERMISSION_MODE`), config-driven `--tools/--allowed-tools/--disallowed-tools`,
  and `--session-id/--resume` session continuity with a stall-resume-once then
  re-establish self-heal.
- **cursor** — `cursor-agent -p --output-format stream-json` with
  capability-probed `--trust/--approve-mcps`; tool and schema constraints are
  injected as prompt hints; the session id is captured from the result event.

The JSON role schemas under `skills/` remain the canonical draft 2019-09
contracts and continue to drive local AJV 2019 validation. For a Claude
JSON-mode call only, the adapter parses the selected canonical schema and
serializes an in-memory copy whose sole contract change is `$schema` =
`http://json-schema.org/draft-07/schema#`; that projected copy is passed to
`--json-schema`. The projection is never written to disk and does not affect
Codex, Cursor, Markdown-mode calls, role payloads, or local validation.

The supported runner set is declared once in `src/providers/registry.ts`
(`RUNNER_META`), from which `Runner`, the config allow-list, dispatch, preflight,
and watchdog knobs all derive. See
[`development/adding-a-provider.md`](development/adding-a-provider.md) for the two
edits that add a provider.

Provider stdout streams are rendered through a shared metadata-only trace:
tool names, target paths, command/text sizes, retry markers, and status
metadata are logged, while prompt, plan, source, tool-argument, and raw provider
stderr bodies are omitted from normal logs. Provider stderr is captured and
bounded rather than inherited directly; non-zero exits produce one
`<role>/<provider> call failed` summary with status, stderr line count, and a
classified reason when recognized. The fixed `schema-incompatible` reason
identifies Claude Code's deterministic `--json-schema` rejection without
copying its stderr. For a Claude JSON-mode call, that category bypasses both
session recovery and transient retries: the original nonzero status returns
after one provider process, a pre-existing resumed creator session is preserved,
and a newly allocated but unestablished session id is removed. Other failure
categories and runners retain their existing recovery and retry behavior. Raw
stdout and stderr are dropped from normal logs by default;
`AGENT_QUORUM_PROVIDER_DIAGNOSTICS=1` adds an additive, opt-in
`$WORK/diagnostics/` directory that captures each call's raw streams chunk-wise
through a best-effort sink that never fails or alters the call.

Write prevention: the read-only guarantee is enforced by toolset and is
independent of permission mode. No role is ever granted Write/Edit/NotebookEdit
or executable Bash — every role, including the creator, lists those in its
disallowed tools.

## The loop

Per iteration: critic → sanitize → schema-validate (exit 3) → health metrics →
converge on zero issues; for `balanced`/`thorough` quality with no open
blocker/major issues, an intermediate judge call exits early when it returns `ready: true`;
otherwise creator update → converge on zero accepted blockers/majors, on a
`diff` below `diffThreshold`, or at `iters` (the last revision becomes final).
Quality shapes the topology: `quick` runs the creator one-shot (plan + metadata
in one JSON call, with a split-call fallback), `balanced` splits markdown and
metadata and enables both judge gates, `thorough` additionally disables provider
sessions. Intermediate `judge.vN.json` evidence is historical and is never used
as the final verdict.

Post-convergence: the reference validator mines `file:line` tokens out of code
spans, resolves them against an in-process workspace snapshot, and writes
`findings.json`; the fix pass proposes → reviews → applies (every failure path
keeps the converged plan). A deterministic split policy then evaluates the
post-fix `plan.final.md` and records `plan.split.json` on every run; when the
policy fires (size signal exceeded or a structural threshold met), the
orchestrator emits a self-contained `plan.package/` derived from the post-fix
plan and validates it into `package-findings.json`. Shape, reference, and package
health first resolve an independent structural status. A structurally blocked
run exits 6 without final Judge evaluation. Every other `balanced`/`thorough`
run then evaluates the exact post-fix `plan.final.md`; schema-invalid output is
retried inside the configured provider policy. A negative or unavailable final
verdict preserves the plan and resolves the overall status to `needs-review`
with exit 0. `quick` remains exempt. Metadata-only `STRUCTURAL`, `FINAL JUDGE`,
and one overall `FINAL:` log precede the translate pass; when a locale is
requested, the non-fatal translate pass renders `plan.final.<locale>.md`, and
`summary.md` closes the run.

The package is a deterministic projection of the post-fix `plan.final.md`: its
`plan.md` is a byte-for-byte copy and its phase docs are slices, so no role ever
gains write tools (the orchestrator writes the package) and the split decision
is reproducible for the same plan + config + workspace. See
[plan-package contract](configuration.md) for the policy knobs.

## Plan shape contract

Existing plan inputs are expected to be complete implementation plans, not
summaries or external pointers. The shape gate requires a leading YAML frontmatter
block (four required keys: `phase_count` integer, `effort_total` non-empty string,
`phases` list with ≥1 item, `status` enum `clean|needs-review|blocked`; delimiters
CRLF-tolerant via `SPACE`), a top-level title, `## At a Glance`, Context, Verified
Facts, Target State, Scope, Work Plan, Files and Interfaces, Verification, STOP
Triggers, and a final `## Impact Graph` with a Mermaid flowchart. Consistency
between the frontmatter header and the Work Plan (phase count, names, effort) is
enforced by the critic, not the gate. Prompt-created and revised plans are
normalized to the same contract by the packaged role skills.

## Artifact contract ($WORK)

`plan.vN.md`, `critique.vN.json`, `update.vN.json`, `update-meta.vN.json`,
`plan.revision.vN.md`, `*.raw` normalization sidecars, `plan.final.md`,
`plan.final.before-fix.md`, `fix-proposal.md`, `fix-review.json`,
`fix-applied.md`, intermediate `judge.vN.json`, final `judge.final.raw`,
schema-valid `judge.final.json`, and `judge.final.meta.json` (canonical plan,
byte-level SHA-256 binding, evaluation state, verdict, rationale, and verdict
artifact), optional `plan.final.<locale>.md`, `findings.json`,
`plan.split.json` (split decision + rationale + signals, every run),
`package-findings.json` (package `file:line` findings, only when split;
never overwrites `findings.json`), the `plan.package/` directory (only when the
split policy fires: `README.md`, `plan.md`, `run.md`, `journal.md`,
`remaining-debt.md`, `phase-*.md`), `summary.md`,
`rejected-log.jsonl`, `operator-interventions.jsonl`,
`operator-intervention-migrations.jsonl`, `clarify-questions.json`,
`clarify-answers.jsonl`, `clarify.offset`, `clarify.done`, `prompt.md`,
`run.meta.tsv`, `run.log`, the opt-in `diagnostics/<seq>-<role>-<provider>.log`
artifacts (only when `AGENT_QUORUM_PROVIDER_DIAGNOSTICS=1`), `creator.session-id`,
and `stale.<timestamp>/` archives on resume (which also archive final Judge,
split, findings, and package artifacts). A registry copy of
`run.meta.tsv` lives in `<state-dir>/<pid>.tsv` while the run is alive.
`clarify.offset` stores the run's cursor into the shared Telegram clarification
journal, not a raw Telegram bot offset.

Every run is also addressable through a durable ledger: each run mints a
sortable, non-digit-leading `runId` and a disambiguated `name`, uses a
run-keyed workdir (`<home>/runs/loop-<name>`), guarantees a followable
`run.log`, and writes `<home>/state/runs/<runId>.json` at start (state
`running` with the real workdir/log paths and pid/pgid/start-token) finalized
to a terminal state at exit. Discovery and the `id`/`name`/`--last`/`pid`
selectors resolve against this ledger; `pid` only ever resolves a live run.

## Watchdog and process hygiene

Claude and cursor calls stream NDJSON through an in-process watchdog with three
independent guards: byte-idle, semantic-idle (assistant/tool/thinking/result
events count as progress), and wall-clock. On trigger: SIGINT → grace → SIGTERM
to the provider's process group; the call reports stall status 124. Providers
spawn detached (own process group) so TERM/INT teardown kills whole subtrees;
the runner exits 143 on signal.

## Resume and interventions

`AGENT_QUORUM_RESUME=1` finds the last stable plan (highest `plan.vN.md` whose
`update.v(N-1).json` validates), archives stale artifacts to
`stale.<timestamp>/`, and continues. Operator interventions append to a JSONL
ledger; active entries are injected into creator/critic/fixer/reviewer prompts
and marked migrated once a revision lands.
