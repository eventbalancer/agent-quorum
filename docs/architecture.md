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
| judge      | evaluates intermediate and canonical final readiness for applicable high risk | JSON (readiness schema) |

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
nullable. Canonically zero-length arrays receive a provider-only item schema
because Codex requires `items` even when `maxItems` is zero; an unconstrained
array without `items` is rejected instead of guessed. `$ref` nodes shed sibling
annotations and constraints in the provider projection because Codex requires a
pure reference; the canonical validator retains and enforces those siblings. The
adapter removes null placeholders for optional properties from the returned
payload before canonical validation and deletes the temporary schema.
Neither compatibility projection changes Cursor prompts, Markdown-mode payloads,
the canonical role contracts, or local validation.

Structural validation is only the first boundary for readiness-bearing role
output. Closed-world semantic admission then verifies the exact plan version,
candidate digest, source lineage, trusted catalog, eight fixed risk domains,
material issue identities, retained context, invariant occurrences, and evidence
grounding. A role artifact that omits, duplicates, invents, crosses, or binds any
of those identities incorrectly is rejected before it can transition proof
state. Equivalent normalized output from every provider enters this same
admission path. Critic, creator-update metadata, fix-reviewer, and Judge calls
perform structural and semantic validation inside the bounded provider retry
boundary. A rejected attempt receives only a trusted code/path repair instruction
plus the deterministic current-candidate anchor catalog; rejected content never
mutates readiness state or enters normal logs. Exhaustion fails closed with a
stable halt instead of exposing a raw admission exception.

### Readiness responsibility ownership

| Responsibility               | Production and focused test scope                                                                                                                         | Input → output                                                                                                                                       | Invariant and handoff                                                                                                                                                                                                                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Decision reduction           | `src/core/readiness-decision.ts`; `tests/unit/readiness-decision.test.ts`                                                                                 | Normalized `ReadinessFacts` → one `ReadinessReduction`                                                                                               | Pure and provider-neutral; owns four-way priority and stable reasons, but never parses role output or mutates proof. The proof lifecycle supplies its facts.                                                                                  |
| Evidence and state lifecycle | `src/core/readiness-{admission,proof,store}.ts`; `tests/unit/readiness-{admission,proof,store}.test.ts`                                                   | Structurally valid role values plus trusted candidate/catalog context → admitted facts, immutable schema-3 state, and canonical persistence          | Closed-world admission precedes every transition; source snapshots replace atomically and aggregates are recomputed. Loop, fix-review, Judge, resume, and finalization use only named transitions/readers.                                    |
| Resume invalidation          | `src/stages/plan/resume.ts`; `tests/unit/resume.test.ts`                                                                                                  | Frozen contract, selected versioned plan, current system facts, and strict stored proof → restored current proof or a resume failure                 | Validates before mutating or archiving, rejects unsupported state, and invalidates stale evidence through lifecycle transitions. The restored state is the only proof handed back to the loop.                                                |
| Finalization and projection  | `src/stages/plan/finalize.ts`; `tests/integration/{readiness-interactions,occurrence-coverage-reconciliation,finalization-proof,final-readiness}.test.ts` | Post-loop proof, structural/package facts, exact fix outcome, and canonical candidate bytes → internal finalization facts plus one `FinalProjection` | Settles exact bytes monotonically, requires applicable deterministic/reviewer/Judge proof, and exposes only `result.projection` to API, durable, summary, CLI, and notification consumers. Renderers may omit detail but never reclassify it. |

The interaction tests named above cover the handoffs that can change decision,
freshness, candidate identity, or public status; responsibility-local tests can
run without provider-backed end-to-end execution.

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

Before `plan.v0.md`, a read-only creator assessment identifies the immutable
goal, `inScope`, `outOfScope`, constraints, and the applicability and risk of
eight fixed domains. Material questions use the existing clarification
transport; the creator reassesses after answers, then the orchestrator freezes
schema-2 `readiness-contract.json` with source/system digests, assurance
appetite, operator-decision IDs, and the trusted proof-catalog identity.
Disabled clarification does not prevent a useful plan,
but an unresolved material question prevents `ready`. A later scope expansion,
out-of-scope removal, appetite increase, or contract/digest mismatch is a
boundary challenge and terminates the run as `unable-to-decide`; the frozen
contract is never rewritten in place.

Per iteration: critic → normalize → schema and semantic validation with bounded
repair → immutable proof transition → optional intermediate Judge admission →
creator update and admitted metadata. Critic `issues` contain only in-boundary
blocker/major concerns;
non-blocking improvements belong in `opportunities.json` and never cause a
creator update. Zero issues, Judge approval, accepted severity, and a `diff`
below `diffThreshold` are telemetry or gate inputs; none is an independent stop
condition.

One deterministic reducer has four outcomes, in order: a material boundary fork
or unavailable required evidence is `unable-to-decide`; exhausted appetite with
material work is `limits-exhausted`; in-boundary blocker/major work is
`revision-required`; all applicable gates complete is `ready`. Only
`revision-required` continues to creator revision. Every other outcome retains
the latest usable version and terminates the loop. The projected `satisfied`
flag is derived exactly as `decision === 'ready'`.

Every required critic, conditionally required fix-reviewer, and applicable Judge
source accounts for each catalog occurrence exactly once with one disposition:

| Disposition      | Admission and normalized outcome                                                               | Readiness effect                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `satisfied`      | Exact identity and grounded evidence; normalizes to `resolved`                                 | Adds no occurrence impediment.                                                         |
| `not-applicable` | Exact identity and evidence grounded against the exact candidate; normalizes to `resolved`     | Adds no occurrence impediment; ungrounded use rejects the role artifact.               |
| `violated`       | Exact identity and grounded evidence; remains `violated`                                       | Makes proof negative; only a separately admitted material issue creates revision work. |
| `unresolved`     | Exact identity is accounted for, but no grounded conclusion is available; remains `unresolved` | Makes proof inconclusive.                                                              |

The occurrence ledger is recomputed from atomic current source snapshots. It
keeps catalog exactness, source currency, conclusiveness, consistency, and proof
satisfaction separate; source disagreement remains explicit. A newer snapshot
replaces its source atomically, so a stale aggregate unresolved ID cannot survive
when every required current source now resolves that occurrence.

Quality is appetite, not a universal proof checklist. `quick` runs the creator
one-shot and supports standard-risk assurance without Judge. `balanced` uses
full cumulative context and targeted Judge calls for applicable high-risk
domains. `thorough` additionally requires an exhaustive scan within applicable
domains and disables provider sessions. A high-risk task under an appetite that
cannot supply its required Judge or scan terminates as
`limits-exhausted:assurance-appetite`. Intermediate `judge.vN.json` evidence is
historical and is never used as the canonical final verdict. When an
intermediate negative verdict includes one grounded blocker or major that is
fixable inside the frozen boundary, the orchestrator appends that structured
finding to the exact-version critique and returns to `revision-required` within
the existing appetite. A negative verdict without such a revision issue remains
`unable-to-decide`; final Judge verdicts never trigger creator changes.

Every planning role receives one mandatory retained-context block: original
scope (or an explicit direct-plan/unavailable marker), authoritative topology,
durable operator decisions, active interventions, material finding
dispositions, invariants and occurrences, the quality promise, and active
bounds. Prior agent conclusions are labeled disputable; role verdicts remain
independent. Optional history can be compacted in `quick`, while mandatory
content is never reduced. Input byte estimates and configured token limits are
recorded as telemetry but do not currently stop provider calls or prevent a
completeness proof.

When the frozen `cross-repository-delivery` domain is applicable,
`system-context.json` resolves repository
names, aliases, and paths actually named by the prompt or direct plan, then
extracts stable relationships from `ecosystem.yaml`, scoped package manifests,
Compose files, and CI workflows. Repository paths must remain inside the
project root after real-path resolution; traversal, absolute-path, and symlink
escapes are excluded and become explicit coverage limitations. When the domain
is not applicable, unavailable topology remains telemetry and cannot block
readiness. When required topology evidence is unavailable, it is reported
separately from plan mismatches and produces `unable-to-decide`, not a
fabricated limit. A
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
`findings.json`. Provider-produced absolute `file-line:` references rooted in
the current repository are normalized deterministically before independent
review; the validator also bounds direct absolute resolution to that repository.
References outside the repository remain unresolved. The fix pass proposes →
reviews → applies, with every failure path keeping the pre-fix candidate. If
reviewed replacement bytes are retained, their exact proposal or applied
candidate binding becomes a required `fix-reviewer` source in the canonical
occurrence ledger. Disabled, skipped, rejected, restored, and no-replacement
paths record an explicit source exemption; evidence for discarded bytes cannot
be promoted to current proof.

A deterministic split policy then evaluates the post-fix candidate and records
`plan.split.json` on every run; when the policy fires (size signal exceeded or a
structural threshold met), the orchestrator emits a self-contained
`plan.package/` and validates it into `package-findings.json`. Shape, reference,
and package health first resolve an independent structural status.

Finalization owns one exact-candidate state machine. It settles the canonical
bytes, projects the frontmatter status, binds the schema-3 readiness proof, runs
the deterministic system check, obtains any required schema-2 final Judge
metadata, and verifies that every required source still targets the same
candidate. A structurally blocked run exits 6 without final Judge evaluation. A
negative or unavailable required verdict preserves the plan and resolves the
overall status to `needs-review` with exit 0. Standard-risk work remains
Judge-exempt regardless of quality. A clean result requires the canonical plan,
deterministic system check, any required fix-review snapshot, and applicable
final Judge verdict to carry compatible exact bindings. A downgrade is monotonic
within the finalization pass, and any late non-status content mutation invalidates
current proof rather than being silently rebound.

Metadata-only `STRUCTURAL`, `FINAL JUDGE`, and translation progress are logged
without role bodies. Package and localized outputs derive from the settled
canonical candidate. When a locale is requested, the non-fatal translate pass
renders `plan.final.<locale>.md`; the orchestrator rechecks the canonical digest
before emitting the single overall `FINAL:` line and closing the run with
`summary.md`.

Live verification is split by purpose. The merge smoke uses two provider-backed
sentinels: a quick standard prompt that must reach `ready` with explicit Judge
and fix-review exemptions, and a balanced high-risk direct plan with a seeded
material defect that must exercise
critic finding, creator revision, fresh exact-version review, conditionally
required fix review, targeted Judge, occurrence reconciliation, and final digest
binding. Deterministic tests own reducer branch coverage. The
ten-task corpus and blind human comparison remain the broader release
calibration for model, prompt, schema, and risk-policy changes rather than an
every-merge gate.

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
normalized to the same contract by the packaged role skills. If a prompt-created
Codex or Cursor plan fails the deterministic shape gate, the creator receives one
bounded corrective call with the invalid output preserved as
`plan.v0.shape-invalid.md`; a second failure exits with code 4. Existing plan
inputs and Claude plan-mode diagnostics do not use this repair path.

## Artifact contract ($WORK)

`readiness-contract.json`, `opportunities.json`, `system-context.json`,
version-matched `convergence.vN.json` and
`system-check.vN.json`, canonical `convergence.final.json` and
`system-check.final.json`, `plan.vN.md`, `critique.vN.json`, `update.vN.json`,
`update-meta.vN.json`,
`plan.revision.vN.md`, `*.raw` normalization sidecars, `plan.final.md`,
`plan.final.before-fix.md`, `fix-proposal.md`, `fix-review.json`,
`fix-applied.md`, `fix-applied-review.json`, intermediate `judge.vN.json`, final `judge.final.raw`,
schema-valid `judge.final.json`, and `judge.final.meta.json` (canonical plan,
byte-level SHA-256 binding, contract/catalog identity, admitted occurrence
coverage, evaluation state, verdict, rationale, and verdict artifact), optional
`plan.final.<locale>.md`, `findings.json`,
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

`readiness-contract.json` uses schema version 2;
`convergence.vN.json` and `convergence.final.json` keep their filenames and use
readiness-proof schema version 3; `judge.final.meta.json` uses schema version 2.
The proof artifacts persist source requirements or exemptions, exact source
bindings and dispositions, normalized occurrence outcomes, aggregate IDs, and
review lineage. Earlier readiness, contract, and Judge-metadata schema versions
are unsupported and are not migrated.

Each iteration line in `summary.md` reports lineage and grounding class counts,
evidence-kind counts, plan lines and bytes, mandatory and optional retained
bytes, issue-budget use, active/resolved invariant coverage, unresolved
occurrences, deterministic relationship coverage, optional omissions, and the
continuation or stop reason. The final readiness lines render the supplied
`FinalProjection`: overall and structural status, decision, stable reason codes,
exact plan version/hash, applicable/high-risk domains, opportunities, limits,
aggregate occurrence counts and source-proof booleans, Judge state, and the
canonical proof artifact. Detailed per-source requirements and per-occurrence
outcomes remain in the machine-readable projection. The summary does not
reclassify proof. These fields are metadata only; prompt, plan, source, provider,
raw evidence-reference bodies, and tool-argument bodies remain excluded.

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
to a terminal state at exit. Run records require `schemaVersion: 1` and carry
one optional `final: FinalProjection`; the public `RunResult.final` and durable
`RunRecord.final` are the same privacy-safe readiness shape. Discovery skips
records with absent, unsupported, malformed, or extra readiness-bearing fields
instead of normalizing them. The `id`/`name`/`--last`/`pid` selectors resolve
against the accepted ledger; `pid` only ever resolves a live run.

## Watchdog and process hygiene

Claude and cursor calls stream NDJSON through an in-process watchdog with three
independent guards: byte-idle, semantic-idle (assistant/tool/thinking/result
events count as progress), and wall-clock. On trigger: SIGINT → grace → SIGTERM
to the provider's process group; the call reports stall status 124. Providers
spawn detached (own process group) so TERM/INT teardown kills whole subtrees;
the runner exits 143 on signal.

## Resume and interventions

`AGENT_QUORUM_RESUME=1` finds the last stable current-contract plan. Every
candidate revision must have a matching, valid schema-3 `convergence.vN.json`
whose catalog, plan version, content digest, source requirements, source
snapshots, and reduction validate against the schema-2 frozen contract. A
state-free revision or an unsupported/corrupt contract or proof halts with the
resume failure contract; resume does not bootstrap or migrate readiness.

Before mutating durable run artifacts, resume verifies the selected plan hash,
frozen source/appetite/catalog identity, readiness-contract digest,
authoritative context, and each current source binding. It restores the
iteration, boundary, appetite, critique, finding/invariant, opportunity,
context, occurrence-source, and limit ledgers; rewinds rejected and
intervention-migration views; and only then archives stale final,
localized-final, proof, system-check, Judge, findings, fix-review, and package
artifacts. A same-version plan mutation, changed authoritative digest, changed
catalog, or stale source lineage invalidates the affected evidence and requires
fresh current-candidate review. Finalization-only fix-review evidence is never
promoted to versioned loop proof. Clarification answers remain durable operator
decisions after their intervention bodies migrate into a plan.
