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
.claude/commands/requirements.md        <-> .agents/skills/requirements/SKILL.md
.claude/commands/solution-handoff.md    <-> .agents/skills/solution-handoff/SKILL.md
.claude/commands/prompt-architect.md    <-> .agents/skills/prompt-architect/SKILL.md
.claude/commands/execute.md             <-> .agents/skills/execute/SKILL.md
.claude/commands/ship.md                <-> .agents/skills/ship/SKILL.md
```

When one side changes, update the other side in the same change and verify the
pairs with `cmp`.

## Artifact Root

All workflow artifacts stay inside the repository-local `.agents` directory:

| Directory                     | Contents                                      |
| ----------------------------- | --------------------------------------------- |
| `.agents/requirements/`       | approved or draft requirements                |
| `.agents/prompts/`            | generated downstream prompts                  |
| `.agents/plans/`              | agent-quorum workdirs and plan-loop artifacts |
| `.agents/execution-journals/` | generated lightweight execute journals        |
| `.agents/skills/`             | mirrored Codex skills, committed source       |

The generated artifact directories are ignored by git. `.agents/skills/` is
source and should be committed when the skill text changes.

## Canonical Chains

Use the shortest chain that still preserves the needed decision boundary.

```text
Raw or ambiguous task:
  /requirements -> /solution-handoff -> /prompt-architect -> confirmed run

Completed investigation:
  /solution-handoff -> /prompt-architect -> confirmed run

Already clear prompt task:
  /prompt-architect -> confirmed run
```

`/requirements` and `/solution-handoff` never start `agent-quorum`. They prepare
context and hand it downstream. `/prompt-architect` saves the prompt, prints the
run profiles, and starts the selected run only after explicit operator
confirmation.

## Stage Contracts

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

- treat the plan as the spec;
- write only deviations, blockers, and verification issues in the journal;
- adapt stale references only when the intended target is clear;
- stop on ambiguous gaps or blockers;
- never stage, commit, push, or open PRs.

## Running agent-quorum

The self-planning harness dogfoods the public package API:

```sh
pnpm run build
pnpm exec tsx scripts/plan-agent-quorum.ts --prompt .agents/prompts/<slug>.md
```

Useful options:

```sh
pnpm exec tsx scripts/plan-agent-quorum.ts --dry-run --prompt .agents/prompts/<slug>.md
pnpm exec tsx scripts/plan-agent-quorum.ts --work .agents/plans/loop-<slug>-high --effort high --iters 7 --prompt .agents/prompts/<slug>.md
```

The harness imports `agent-quorum`, not `src/index.ts`, so it behaves like an
external TypeScript consumer of the built package. Run `pnpm run build` first.

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
cmp -s .claude/commands/requirements.md .agents/skills/requirements/SKILL.md
cmp -s .claude/commands/solution-handoff.md .agents/skills/solution-handoff/SKILL.md
cmp -s .claude/commands/prompt-architect.md .agents/skills/prompt-architect/SKILL.md
cmp -s .claude/commands/execute.md .agents/skills/execute/SKILL.md
cmp -s .claude/commands/ship.md .agents/skills/ship/SKILL.md
```

## Quick Selection Guide

- Use `/requirements` when the operator still needs to decide scope, behavior,
  compatibility, priority, or acceptance.
- Use `/solution-handoff` when the problem is known but should be reframed
  without a baked-in solution.
- Use `/prompt-architect` when the next useful artifact is a planning prompt and
  a confirmed `agent-quorum` run.
- Use `/execute` when an already approved or implementation-ready plan should
  be carried out with a lightweight deviation journal.
- Skip the chain for small, obvious edits where direct implementation is safer
  and cheaper than ceremony.
