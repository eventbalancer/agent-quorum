# Agent Skill Development Flow

This document defines the development flow for using the repository-local agent
skills around `agent-quorum` itself. It complements
[`conventions.md`](conventions.md): conventions define how code is changed;
this document defines how requirements, handoff prompts, and planning artifacts
move through the skill chain.

## Purpose

Use the skill flow when a change needs more than a direct edit: unclear product
intent, public API or CLI impact, schema/prompt contract changes, cross-module
design, or an investigation that should be turned into a systemic fix.

The flow keeps three boundaries clear:

- requirements decide **what must be true**;
- handoff preserves **the problem and evidence**, not a solution;
- prompt architecture creates **the downstream planning prompt** and is the only
  step that may start `agent-quorum`.

## Skills

The workflow Claude commands and Codex skills are mirrored byte-for-byte:

```text
.claude/commands/issues.md              <-> .agents/skills/issues/SKILL.md
.claude/commands/requirements.md        <-> .agents/skills/requirements/SKILL.md
.claude/commands/solution-handoff.md    <-> .agents/skills/solution-handoff/SKILL.md
.claude/commands/prompt-architect.md    <-> .agents/skills/prompt-architect/SKILL.md
.claude/commands/execute.md             <-> .agents/skills/execute/SKILL.md
.claude/commands/refactor.md            <-> .agents/skills/refactor/SKILL.md
.claude/commands/tidy.md                <-> .agents/skills/tidy/SKILL.md
.claude/commands/ship.md                <-> .agents/skills/ship/SKILL.md
.claude/commands/sync-main.md           <-> .agents/skills/sync-main/SKILL.md
.claude/commands/switch.md              <-> .agents/skills/switch/SKILL.md
.claude/commands/delivery.md            <-> .agents/skills/delivery/SKILL.md
```

When one side changes, update the other side in the same change and verify the
pairs with `cmp`.

The working-tree-dependent skills `refactor`, `tidy`, `ship`, `execute`, and `sync-main`
additionally share the [Worktree selection gate](worktree-selection-gate.md):
before acting, each resolves and enters the operator's intended session
worktree. `/switch` uses the same gate semantics when presenting targets and
confirming an actively edited worktree. The worktree-agnostic skills `issues`,
`requirements`, and `solution-handoff` (and `prompt-architect`) do not present
the gate, because they never act on a checkout's working tree.

## Artifact Root

All workflow artifacts stay inside the repository-local `.agents` directory:

| Directory                     | Contents                                         |
| ----------------------------- | ------------------------------------------------ |
| `.agents/requirements/`       | approved or draft requirements                   |
| `.agents/prompts/`            | generated downstream prompts                     |
| `.agents/plans/`              | agent-quorum workdirs and agent-quorum artifacts |
| `.agents/execution-journals/` | generated lightweight execute journals           |
| `.agents/skills/`             | mirrored Codex skills, committed source          |

The generated artifact directories are ignored by git. `.agents/skills/` is
source and should be committed when the skill text changes.

## Authorized autonomous delivery

The existing skill workflows are interactive by default. The repository-local
delivery controller provides a second invocation context after explicit operator
activation for `eventbalancer/agent-quorum`. See
[Autonomous delivery](../autonomous-delivery.md) for preparation, activation,
inspection, scope changes, pause, stop, recovery, and manual release ownership.
Approved requirements, a delivery-related issue, or a skill invocation never
activate the controller by themselves.

Before applying an autonomous exception, validate the durable mandate, assigned
issue, execution profile, and exact owned worktree. The controller broker checks
the current authority and limits before each external effect. Issue text and
candidate changes to code, skills, CI, or policy cannot authorize additional
operations or weaken the active run's gates. Workers propose actions and return
evidence; they do not perform delivery writes directly.

| Stage                      | Authorized autonomous behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Intake and requirements    | Reconcile current `main`, issues, pull requests, dependencies, and ownership. Record observable acceptance criteria and technical/product decisions with rationale, affected contracts, and mandate provenance. Do not invent operator sign-off. Incompatible changes are permitted within the repository's product purpose.                                                                                                                                                                                                                                                                     |
| Preparation and planning   | Use the shortest sufficient route. Simple unambiguous fixes may proceed without a planning loop. Design planning uses the frozen supported profile and finite bounds. Admit a generated plan only with applicable current readiness proof bound to that exact plan; exit 0 and `plan.final.md` alone are insufficient.                                                                                                                                                                                                                                                                           |
| Execute and quality passes | Continue assigned phases within the mandate. Resolve scoped technical/product choices; reconcile contradictions or defer bounded blockers. Keep necessary acceptance fixes in scope and classify separate findings rather than enlarging the task silently. Before verification, apply one bounded `/refactor` pass followed by `/tidy`; both preserve behavior. Refactor may touch justified related files for the same improvement. Skip edits when no worthwhile improvement exists; overlapping readability work is valid. Existing issue limits and the frozen broker remain authoritative. |
| Findings                   | Classify necessary fixes, adjacent actionable work, blocking prerequisites, and unverified observations. Search relevant existing issues with complete pagination, preserve evidence including useful file/line references, then propose one linked issue or an update through the broker. Preserve operation markers and relationships; uncertain creation is reconciled before retry.                                                                                                                                                                                                          |
| Project status             | Use only the optional project/status mapping recorded for the run. An unconfigured project is valid. Missing configured access or mapping is a visible reconciliation problem; do not invent a board or repeatedly ask for one.                                                                                                                                                                                                                                                                                                                                                                  |
| Delivery                   | Use the broker's owned branch and PR, independent review, applicable local verification, and successful current required GitHub checks with trusted provenance. Confirm the actual merge and integrated `main` checks, then reconcile issues and dependencies. A push is partial progress. Mark work done only at the controller's terminal outcome.                                                                                                                                                                                                                                             |
| Base updates               | Merge current `origin/main` into the owned issue branch through the controller. Do not invoke the interactive `sync-main` rebase/force-push flow. Refresh affected review and verification evidence after a changed candidate.                                                                                                                                                                                                                                                                                                                                                                   |

Only one issue has active implementation/delivery ownership. Create its worktree
from the fetched, verified `origin/main` revision using an explicit `--from`
value; the ordinary worktree command's best-effort local base sync is insufficient
for autonomous admission. Refresh ownership and preserve other sessions' trees.
Advisory active-edit markers never authorize taking a foreign worktree.

The active allowance is 120 minutes per issue, two post-review repair cycles,
and 360 active minutes per Europe/Moscow calendar day. Analysis, provider latency,
planning, review, local verification, repairs, and backlog maintenance are active;
passive GitHub CI waiting is excluded. Overlapping work on the same issue counts
elapsed time once. Shared backlog work counts daily. Resume does not reset
counters, and a new day does not restore an exhausted issue's allowance.

Design planning and live plan-generation testing have separate purposes and
evidence. Preserve mandatory merge sentinels; launch other live tests only for a
recorded material uncertainty that cheaper checks cannot resolve. Reuse successful
unaffected scenarios, defer when a required gate cannot fit the remaining budget,
and reserve full release calibration for manual release work.

Pause prevents new stages after acknowledgment. Stop terminates owned active
work and preserves recoverable outputs; revoked authority prevents subsequent
delivery actions. Reconcile uncertain processes and GitHub outcomes before
continuing. Defer issue-local blockers and continue eligible independent work;
shared infrastructure or unhealthy `main` blocks delivery. Unchanged blockers and
empty queues generate no repeated notifications.

Never take the interactive release route, direct-to-main bypass, force-push,
verification-risk waiver, or routine post-push completion shortcut. Missing
independent review, effective permissions, finite bounds, or enforceable merge
gates leaves activation visibly blocked. Updating this document cannot change
the running controller's frozen policy.

## Canonical Chains

Use the shortest chain that still preserves the needed decision boundary. The
following confirmations describe interactive invocation; authorized autonomous
delivery uses the stage rules above.

```text
Session insights to capture for later:
  /issues -> (per issue, later) /requirements -> /solution-handoff -> /prompt-architect -> confirmed run

Raw or ambiguous task:
  /requirements -> /solution-handoff -> /prompt-architect -> confirmed run

Completed investigation:
  /solution-handoff -> /prompt-architect -> confirmed run

Already clear prompt task:
  /prompt-architect -> confirmed run

Before nontrivial implementation (multi-file or potentially concurrent):
  pnpm run worktree:create <slug> --desc "<task>" -> pnpm run worktree:open <slug> -> work inside the worktree

After implementation (a confirmed run, /execute, or a direct edit):
  /refactor -> /tidy -> verification -> /ship
```

Refactor and tidy are ordinary quality work under the existing implementation
request, not new approval stages. Run them before final verification and keep
already-current pass results instead of repeatedly polishing unchanged code.
Do not expand a focused change into a redesign or require edits just to record a
pass. Standalone invocations retain their requested scope; git delivery and
controller activation still require their existing authorization.

`/requirements` and `/solution-handoff` never start `agent-quorum`. They prepare
context and hand it downstream. `/prompt-architect` saves the prompt, prints the
run profiles, and starts the selected run only after explicit operator
confirmation in interactive mode. The autonomous controller owns approved
planning launches under its existing mandate and execution profile.

Nontrivial, multi-file, or potentially concurrent implementation runs inside a
session worktree created with `pnpm run worktree:create <slug> --desc "<task>"`
before the implement, `/refactor`, `/tidy`, and `/ship` steps; see the
[Session Worktrees](conventions.md#session-worktrees) convention. `worktree:create`
writes the two carriers the [Worktree selection gate](worktree-selection-gate.md)
consumes — the durable task description (`agent-quorum-task.md`) and the active-edit
marker (`agent-quorum-active-edit.json`) in the worktree's git admin dir — so
`refactor`, `tidy`, `ship`, and `execute` can target the right worktree and `worktree:release`
cleans both up. After delivery, `/ship` marks the session worktree done (a third
`agent-quorum-done.json` carrier) so the gate ignores finished work by default,
while `worktree:reopen` brings it back and `worktree:release` removes it once
merged.

## Stage Contracts

### issues

Use to capture loose improvement and fix directions from the current session as
tracked proposals before they are lost. It is the optional front door of the
flow, not a required step.

Outputs:

- one proposal-level GitHub issue per cluster, created only after operator
  confirmation;
- each created issue added to the repository's linked project board in its
  backlog column;
- no implementation details, no chosen solution, no checkout edits.

Rules:

- ground every candidate in the current conversation;
- cluster related directions and de-duplicate against open issues;
- keep issue bodies outcome-level and solution-free;
- file into the board backlog; skip the board step and report it if no project
  is linked;
- point each issue at the downstream flow; never start `agent-quorum`.

### requirements

Use when the operator request has unresolved product, behavior, compatibility,
priority, or acceptance forks.

Outputs:

- `.agents/requirements/<slug>.md`;
- status `draft` or `approved`;
- operator decisions in the decision log;
- acceptance criteria mapped to functional requirements.

Rules:

- write the saved document in English;
- keep requirements outcome-level and solution-free;
- ask the operator about material forks;
- hand approved work to `/solution-handoff`, not directly to planning.

### solution-handoff

Use after an investigation has confirmed root causes, or after requirements are
approved.

Outputs:

- clustered problem dossiers for `/prompt-architect`;
- no implementation edits;
- no prescribed fix.

Rules:

- carry facts, evidence, hypotheses, and open questions;
- strip candidate edits and future entity names;
- merge related defects into the smallest useful set of clusters;
- route product-level ambiguity back through `/requirements`.

### prompt-architect

Use to compose the actual downstream planning prompt.

Outputs:

- `.agents/prompts/<slug>.md`;
- Thorough/Balanced/Quick run profiles;
- an explicit launch confirmation question;
- on approval, a run under `.agents/plans/loop-<slug>-<quality>/`.

Rules:

- write a problem-first XML prompt;
- keep requirements and plan bodies out of the prompt; reference their paths and
  tell the downstream agent to read them;
- keep commands identical except for quality, iteration cap, and workdir suffix;
- launch only after explicit confirmation.

### execute

Use when an implementation-ready plan should be carried out directly.

Outputs:

- implementation changes in the checkout;
- `.agents/execution-journals/exec-<slug>-<YYYY-MM-DD>.md`;
- verification results reported to the operator.

Rules:

- resolve and enter the target worktree via the Worktree selection gate before
  acting;
- treat the plan as the spec;
- write only deviations, blockers, and verification issues in the journal;
- adapt stale references only when the intended target is clear;
- stop on ambiguous gaps or blockers;
- never stage, commit, push, or open PRs.

### refactor

Use after implementation and before tidy for a bounded structural and readability
pass over the current change. Existing implementation authorization covers this
within-scope quality work; do not add a routine stage confirmation.

Outputs:

- behavior-preserving improvements with an immediate, concrete maintenance benefit;
- justified related-file changes when required for the same refactor;
- verification results and any larger opportunity left outside the current work.

Rules:

- resolve and enter the target worktree via the Worktree selection gate;
- read scoped code, affected callers, and tests before choosing changes;
- simplify control flow, responsibilities, duplication, names, or data flow only
  where the current code benefits; avoid speculative abstractions and redesign;
- perform one focused pass, then stop when worthwhile opportunities are exhausted;
  a pass with no edits is a valid outcome;
- preserve behavior, public contracts, authority boundaries, and unrelated work;
- follow with tidy and verify the resulting bytes; the two skills may overlap;
- never stage, commit, push, or open PRs.

### tidy

Use after refactor and before final verification or any commit, to polish the
dirty change set without altering behavior. Emphasize repository conventions and
local clarity; readability and structure improvements may overlap with refactor.

Outputs:

- readability, structure, and convention fixes confined to the dirty set;
- reconciled mirror pairs and related documentation;
- verification results reported to the operator.

Rules:

- resolve and enter the target worktree via the Worktree selection gate before
  acting;
- work only inside the dirty set plus documented mirror counterparts;
- preserve behavior; surface anything needing wider edits as separate work;
- reconcile mirror pairs and docs when names, paths, or contracts change;
- never stage, commit, push, or open PRs.

### ship

Use to deliver the change set through the repository's git, verification, and
release boundaries. The terminal step of the flow and the only skill that
commits, pushes, or publishes.

Outputs:

- a change-set flow that verifies, commits, optionally pushes dirty changes, and
  marks the session worktree done after a successful push;
- a release flow following `docs/release.md` for version bump, tag, publish
  approval, and a commit-range-based GitHub Release description.

Rules:

- resolve and enter the target worktree via the Worktree selection gate before
  acting;
- act only in the `agent-quorum` checkout; keep unrelated dirt out of scope;
- show the exact irreversible plan before staging, committing, pushing, tagging,
  or triggering publish workflows;
- run the verification floor before delivery;
- commit, push, and publish only on explicit operator instruction.

## Running agent-quorum

Dogfood the loop through the `agent-quorum` bin, run straight from source. When
an agent starts the run on the operator's behalf, use the detached
`run:cli -- launch`: it returns immediately and the run survives the Claude Code
session that started it being closed.

```sh
pnpm run run:cli -- launch --prompt .agents/prompts/<slug>.md
```

Useful options:

```sh
pnpm run run:cli -- launch --quality balanced --iters 5 --prompt .agents/prompts/<slug>.md
AGENT_QUORUM_WORK_DIR=.agents/plans/loop-<slug>-balanced pnpm run run:cli -- launch --quality balanced --iters 5 --prompt .agents/prompts/<slug>.md
```

`run:cli -- launch` prints a `started:` block (run log path plus follow/stop
commands); observe the run afterward with `pnpm run run:cli -- logs --last -f`. Use
the foreground `pnpm run run:cli -- plan …` instead for interactive, session-bound
debugging where blocking output is wanted.

Both scripts run `src/cli/main.ts` via `tsx` — no build step — and write run
artifacts and the ledger under `.agents/plans/`. For the public API path that
external consumers use, see [`examples/api.ts`](../../examples/api.ts).

## Smoke testing

Use the smoke harness to confirm the `plan` stage still runs end to end after a
change, cheaply and without a real planning task. There is one general smoke per
provider — each configures the roles used by the smoke for that provider's cheap
model, runs the quick creator/critic path over the committed
[`scripts/smoke.plan.md`](../../scripts/smoke.plan.md) prompt, and writes to
`.agents/plans/smoke-<provider>/`.

```sh
pnpm run test:smoke:codex     # quick creator/critic path on codex gpt-5.5
pnpm run test:smoke:claude    # quick creator/critic path on claude sonnet
pnpm run test:smoke:cursor    # quick creator/critic path on cursor composer-2.5
```

Each general smoke is a single quick-quality iteration with no fix or translate
pass. Clarification is explicitly disabled, quick quality disables the judge,
and `--no-fix --no-translate` leaves the fixer, reviewer, and translator paths
inactive. The schema-3 proof must represent the inactive fix-reviewer and Judge
sources as explicit exemptions; absence is not proof. A pass ends with
`FINAL: clean` or `FINAL: needs-review` and exit 0, leaving `plan.final.md`,
`convergence.final.json`, and `summary.md` in the workdir.
`test:smoke:claude` runs on `sonnet`: in `default` permission mode a cheap
claude creator returns a complete plan, but the `haiku` critic still emits
schema-invalid critique JSON, so `sonnet` is the smallest claude tier that turns
the quick path green (see the recommended creator-tier table in
[`configuration.md`](../configuration.md)). Override the model or input:

```sh
SMOKE_MODEL=sonnet pnpm run test:smoke:claude
SMOKE_PROMPT=.agents/prompts/<slug>.md pnpm run test:smoke:codex
```

Use the separate authenticated compatibility smoke to exercise every Claude
JSON-mode contract through the production provider boundary:

```sh
pnpm run test:smoke:claude-schemas
```

This command invokes clarification, one-shot creator update, split update
metadata, critique, fix review, and readiness judgment with bounded synthetic
prompts. It disables provider retries and sessions, validates every returned
artifact against its canonical draft 2019-09 schema, reports one pass/fail line
per contract, and stops at the first failure. It prints `claude --version` for
the verification record but does not gate on the version string. The default
model is `sonnet`; `SMOKE_MODEL` overrides it.

These are strict current role schemas. At runtime, readiness-bearing critic,
creator-update, fix-reviewer, and Judge payloads additionally pass closed-world
semantic admission for exact plan/candidate and lineage binding, trusted catalog
identities, all retained occurrences, material dispositions, and grounded
evidence. Each occurrence uses `satisfied`, grounded `not-applicable`,
`violated`, or `unresolved`; the schema smoke proves representability, while the
deterministic admission/proof suites own identity rejection and cross-source
reconciliation. Pre-change role payloads are not backfilled.

`test:smoke:claude-schemas` requires an authenticated Claude CLI and performs six
live provider calls. It is an opt-in release verification command, outside
`pnpm run test` and CI. Run the general `test:smoke:claude` afterward when
end-to-end creator/critic confidence is also required.

## Verification

For skill or workflow documentation changes:

```sh
pnpm run format:check
```

For script, public contract, schema, provider, CLI, or orchestration changes:

```sh
pnpm run check
```

Before finishing, verify mirrors when skill text changed:

```sh
cmp -s .claude/commands/issues.md .agents/skills/issues/SKILL.md
cmp -s .claude/commands/requirements.md .agents/skills/requirements/SKILL.md
cmp -s .claude/commands/solution-handoff.md .agents/skills/solution-handoff/SKILL.md
cmp -s .claude/commands/prompt-architect.md .agents/skills/prompt-architect/SKILL.md
cmp -s .claude/commands/execute.md .agents/skills/execute/SKILL.md
cmp -s .claude/commands/refactor.md .agents/skills/refactor/SKILL.md
cmp -s .claude/commands/tidy.md .agents/skills/tidy/SKILL.md
cmp -s .claude/commands/ship.md .agents/skills/ship/SKILL.md
```

## Quick Selection Guide

- Use `/issues` when a session surfaced follow-ups or ideas worth tracking as
  GitHub proposals before they are lost.
- Use `/requirements` when the operator still needs to decide scope, behavior,
  compatibility, priority, or acceptance.
- Use `/solution-handoff` when the problem is known but should be reframed
  without a baked-in solution.
- Use `/prompt-architect` when the next useful artifact is a planning prompt and
  a confirmed `agent-quorum` run.
- Use `/execute` when an already approved or implementation-ready plan should
  be carried out with a lightweight deviation journal.
- Use `/refactor` after implementation for bounded structural and readability
  improvements, including justified related files. No worthwhile edit is required.
- Use `/tidy` after refactor and before final verification to polish conventions
  and local clarity in the dirty change set without changing behavior.
- Use `/ship` to commit, push, or release the change set through the
  repository's delivery boundaries.
- Skip the chain for small, obvious edits where direct implementation is safer
  and cheaper than ceremony.
