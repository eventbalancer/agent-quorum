# Architecture

## Roles and providers

Six roles drive the loop, each resolved to a provider through the per-user
config store (`override > env > store > default` per field):

| Role       | Purpose                                                                       | Mode                    |
| ---------- | ----------------------------------------------------------------------------- | ----------------------- |
| critic     | finds issues in the current plan                                              | JSON (critique schema)  |
| creator    | creates plan.v0 and applies critique verdicts                                 | markdown + JSON         |
| fixer      | proposes/applies reference fixes after the bounded loop                       | markdown                |
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
contracts and continue to drive local AJV 2019 validation. The Claude JSON-mode
adapter serializes an in-memory copy whose sole contract change is `$schema` =
`http://json-schema.org/draft-07/schema#` and passes it to `--json-schema`. The
Codex JSON-mode adapter creates a temporary Structured Outputs projection in
which every object property is required and canonical optional properties are
nullable. It removes null placeholders for those optional properties from the
returned payload before canonical validation and deletes the temporary schema.
Neither compatibility projection changes Cursor prompts, Markdown-mode payloads,
the canonical role contracts, or local validation.

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

Per iteration: critic → sanitize → schema-validate (exit 3) → lineage,
grounding, invariant, and deterministic-system checks → optional intermediate
Judge → creator update. Zero issues, Judge approval, accepted severity, and a
`diff` below `diffThreshold` are telemetry or convergence candidates; none can
finalize by itself. A plan converges only after an independent critic has
reviewed that exact revision, the quality scan is complete, no blocker/major is
open, every invariant occurrence is satisfied or evidence-backed
not-applicable, deterministic system checks pass, no material bound is
exhausted, and the required intermediate Judge approved it. The iteration cap
preserves the latest revision but reports `needs-review` when it has not been
re-reviewed.
Quality shapes the topology: `quick` runs the creator one-shot (plan + metadata
in one JSON call, with a split-call fallback), `balanced` splits markdown and
metadata and enables both judge gates, `thorough` additionally disables provider
sessions. Intermediate `judge.vN.json` evidence is historical and is never used
as the final verdict.

Every planning role receives one mandatory retained-context block: original
scope (or an explicit direct-plan/unavailable marker), authoritative topology,
durable operator decisions, active interventions, material finding
dispositions, invariants and occurrences, the quality promise, and active
bounds. Prior agent conclusions are labeled disputable; role verdicts remain
independent. Optional history can be compacted in `quick`, while mandatory
content is never reduced. Input byte estimates and configured token limits are
recorded as telemetry but do not currently stop provider calls or prevent a
completeness proof.

For declared cross-repository scope, `system-context.json` resolves repository
names, aliases, and paths actually named by the prompt or direct plan, then
extracts stable relationships from `ecosystem.yaml`, scoped package manifests,
Compose files, and CI workflows. Repository paths must remain inside the
project root after real-path resolution; traversal, absolute-path, and symlink
escapes are excluded and become explicit coverage limitations. A
multi-repository ecosystem alone does not make a task cross-repository, and
unrelated per-repository sources do not enter the scoped digest. An explicit
multi-repository request whose repositories cannot be resolved records a
blocking coverage limitation. Package manifests, exports, scripts, public
consumers, image publication/dependencies, workflow triggers/order, migrations,
delivery stages, authorization boundaries, regions, and production gates become
typed relationship obligations when authoritative sources expose them. The
master plan must carry one `## System Coverage` disposition per
relationship, tying the producer/authority and consumer/executor to both an
implementation phase and an ordered release stage or gate. Deterministic
validation checks identity, phase references, package/image/CI/gate tokens, and
producer-before-consumer or migration-before-deployment order. A
`not-applicable` row must cite a supported, existing file-line, plan section,
phase/gate, command, repository, or topology target. A missing external
relationship is recorded as a coverage limitation rather than invented. When a
split package is emitted, `plan.md` remains byte-identical,
phase documents receive their applicable rows, and `run.md` carries the ordered
release gates.

Post-loop: the reference validator mines `file:line` tokens out of code
spans, resolves them against an in-process workspace snapshot, and writes
`findings.json`; the fix pass proposes → reviews → applies (every failure path
keeps the pre-fix canonical plan). A deterministic split policy then evaluates the
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
and translation progress are logged without role bodies. When a locale is
requested, the non-fatal translate pass renders `plan.final.<locale>.md`; the
orchestrator then rechecks the canonical plan digest before emitting the single
overall `FINAL:` line and closing the run with `summary.md`. A clean result
requires the canonical plan, deterministic system check, and applicable final
Judge verdict to carry the same SHA-256; an intervening same-version mutation
is retained as a usable `needs-review` result instead of being silently rebound.

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

`system-context.json`, version-matched `convergence.vN.json` and
`system-check.vN.json`, canonical `convergence.final.json` and
`system-check.final.json`, `plan.vN.md`, `critique.vN.json`, `update.vN.json`,
`update-meta.vN.json`,
`plan.revision.vN.md`, `*.raw` normalization sidecars, `plan.final.md`,
`plan.final.before-fix.md`, `fix-proposal.md`, `fix-review.json`,
`fix-applied.md`, `fix-applied-review.json`, intermediate `judge.vN.json`, final `judge.final.raw`,
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

Each iteration line in `summary.md` reports lineage and grounding class counts,
evidence-kind counts, plan lines and bytes, mandatory and optional retained
bytes, issue-budget use, active/resolved invariant coverage, unresolved
occurrences, deterministic relationship coverage, optional omissions, and the
continuation or stop reason. The final convergence lines record the selected
promise, whether it was satisfied, exhausted limits, unresolved coverage IDs,
and the canonical convergence artifact. These fields are metadata only; prompt,
plan, source, provider, and tool-argument bodies remain excluded.

Lineage counts distinguish `new`, `refinement` of the immediately relevant
parent, `recurring` older lineage, `reopened` rejected or resolved material,
`revision-regression`, `rejected-duplicate`, and `invalid-lineage`. Grounding
counts distinguish a valid `grounded` target, recognized but `malformed`
syntax/nonexistent targets, a declared-kind `format-mismatch`, and `unanchored`
claims with no supported reference.

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

`AGENT_QUORUM_RESUME=1` finds the last stable plan. New-format revisions require
their matching valid convergence state, which is committed only after that
revision's rejected-disposition ledger entries; legacy revisions retain
update-schema selection and bootstrap a conservative unproved state. Before mutating durable
run artifacts, resume rejects a changed source, quality promise, or iteration
contract. It restores the iteration, critique, finding/invariant, context, and
limit ledger; rewinds rejected and intervention-migration views; and archives
stale final, localized-final, convergence, system-check, Judge, findings, and
package artifacts. Convergence and deterministic check artifacts carry SHA-256
bindings to the exact versioned or canonical plan bytes. A same-version plan
mutation or changed authoritative digest invalidates prior proof and requires a
fresh current-plan review. Clarification answers remain durable operator
decisions after their intervention bodies migrate into a plan.
