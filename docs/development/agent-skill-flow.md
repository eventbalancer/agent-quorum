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
.claude/commands/tidy.md                <-> .agents/skills/tidy/SKILL.md
.claude/commands/ship.md                <-> .agents/skills/ship/SKILL.md
```

When one side changes, update the other side in the same change and verify the
pairs with `cmp`.

The working-tree-dependent skills `tidy`, `ship`, and `execute` additionally
share the [Worktree selection gate](worktree-selection-gate.md): before acting,
each resolves and enters the operator's intended session worktree. The
worktree-agnostic skills `issues`, `requirements`, and `solution-handoff` (and
`prompt-architect`) do not present the gate, because they never act on a
checkout's working tree.

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

## Canonical Chains

Use the shortest chain that still preserves the needed decision boundary.

```text
Session insights to capture for later:
  /issues -> (per issue, later) /requirements -> /solution-handoff -> /prompt-architect -> confirmed run

Raw or ambiguous task:
  /requirements -> /solution-handoff -> /prompt-architect -> confirmed run

Completed investigation:
  /solution-handoff -> /prompt-architect -> confirmed run

Already clear prompt task:
  /prompt-architect -> confirmed run

After implementation (a confirmed run, /execute, or a direct edit):
  /tidy -> /ship
```

`/requirements` and `/solution-handoff` never start `agent-quorum`. They prepare
context and hand it downstream. `/prompt-architect` saves the prompt, prints the
run profiles, and starts the selected run only after explicit operator
confirmation.

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
- Max/High/Low run profiles;
- an explicit launch confirmation question;
- on approval, a run under `.agents/plans/loop-<slug>-<effort>/`.

Rules:

- write a problem-first XML prompt;
- keep requirements and plan bodies out of the prompt; reference their paths and
  tell the downstream agent to read them;
- keep commands identical except for effort, iteration cap, and workdir suffix;
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

### tidy

Use after a change is implemented and before any commit, to refactor the dirty
change set without altering behavior.

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

- a change-set flow that verifies, commits, and optionally pushes dirty changes;
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

Dogfood the loop through the `agent-quorum` bin, run straight from source:

```sh
pnpm run plan:self -- --prompt .agents/prompts/<slug>.md
```

Useful options:

```sh
pnpm run plan:self -- --effort high --iters 5 --prompt .agents/prompts/<slug>.md
AGENT_QUORUM_WORK_DIR=.agents/plans/loop-<slug>-high pnpm run plan:self -- --effort high --iters 5 --prompt .agents/prompts/<slug>.md
```

`plan:self` runs `src/cli/main.ts` via `tsx` — no build step — and writes run
artifacts and the ledger under `.agents/plans/`. For the public API path that
external consumers use, see [`examples/api.ts`](../../examples/api.ts).

## Smoke testing

Use the smoke harness to confirm the `plan` stage still runs end to end after a
change, cheaply and without a real planning task. There is one smoke per
provider — each runs the whole loop on that provider's cheap model over the
committed [`scripts/smoke.plan.md`](../../scripts/smoke.plan.md) prompt and
writes to `.agents/plans/smoke-<provider>/`.

```sh
pnpm run smoke:codex     # all roles on codex gpt-5.5
pnpm run smoke:claude    # all roles on claude sonnet
pnpm run smoke:cursor    # all roles on cursor composer-2.5
```

Each is a single low-effort iteration with no fix or translate pass. A pass ends
with `FINAL: clean` or `FINAL: needs-review` and exit 0, leaving `plan.final.md`
and `summary.md` in the workdir. `smoke:claude` runs on `sonnet`: in `default`
permission mode a cheap claude creator returns a complete plan, but the `haiku`
critic still emits schema-invalid critique JSON, so `sonnet` is the smallest
claude tier that turns the whole loop green (see the recommended creator-tier
table in [`configuration.md`](../configuration.md)). Override the model,
reasoning, or input:

```sh
SMOKE_MODEL=sonnet SMOKE_REASONING=high pnpm run smoke:claude
SMOKE_PROMPT=.agents/prompts/<slug>.md pnpm run smoke:codex
```

## Verification

For skill or workflow documentation changes:

```sh
pnpm run format-check
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
- Use `/tidy` after implementation and before commit to refactor the dirty
  change set without changing behavior.
- Use `/ship` to commit, push, or release the change set through the
  repository's delivery boundaries.
- Skip the chain for small, obvious edits where direct implementation is safer
  and cheaper than ceremony.
