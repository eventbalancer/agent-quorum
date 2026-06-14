---
name: requirements
description: Turn an unformalized agent-quorum task, problem, or idea into a formal, operator-approved requirements document before solution-handoff, prompt composition, and confirmed self-planning.
---

# requirements

Turn an unformalized task, problem, or idea into a formalized,
operator-approved requirements document for `agent-quorum`. This is the entry
step of the delivery cycle: it fixes **what must be true** when the work is
done, never **how to build it**.

- Upstream: a raw operator request, or investigation context already in the
  conversation (`/solution-handoff`, ad-hoc debugging, review findings).
- Downstream: `/solution-handoff` -> `/prompt-architect` -> confirmed
  `agent-quorum` self-planning run -> implementation.

Follow the repository-root `AGENTS.md` / `CLAUDE.md` operating rules and
`docs/development/conventions.md`.

## Arguments

```text
/requirements <raw task>
/requirements
```

`$ARGUMENTS` is optional. Empty `$ARGUMENTS` with investigation context means
formalize that context. Empty `$ARGUMENTS` with no context means ask the
operator for the task first.

## Philosophy

Requirements describe outcomes and constraints, never solutions: no chosen
approaches, no names of future entities, no implementation steps. The document
separates:

- **facts**: verified against code, docs, config, or operator statements, with
  evidence;
- **assumptions**: unverified, explicitly labeled;
- **decisions**: operator choices at material forks.

The operator is a required participant. Every material fork the agent cannot
ground in evidence goes to the operator as an explicit question in the
operator's conversation language with concrete options.

## Instructions

### Step 1 — Intake and classify

Determine the input mode:

- **Raw task**: free text from the operator.
- **Harvest**: empty arguments with confirmed investigation context in the
  conversation. Collect symptoms, root causes with `file:line`, affected
  components, and open questions already established. Do not re-investigate
  confirmed facts.
- **Cold call**: empty arguments and no context. Use the host's structured
  question tool when available to ask one free-form task question in the
  operator's conversation language. If no structured tool exists, ask in plain
  chat and keep approval pending.

Classify the request: new capability, changed behavior, defect class, docs/API,
config/tooling, release/process, or role-skill/schema contract.

When the task originates from a GitHub issue — an issue URL or number in the
request, or a harvested investigation tracked under one — record its
`<org/repo#n>` reference in the `Issue:` field so the delivery chain can close it.
Set `Issue: none` when no issue is associated.

### Step 2 — Product and technical reconnaissance

Run bounded reconnaissance to ground the requirements and discover forks. Do not
design or deep-dive into implementation.

Check the relevant surfaces:

- CLI behavior: `src/cli/*`, `docs/cli.md`, `package.json` `bin` and scripts.
- Public API: `src/index.ts`, `docs/api.md`, `package.json` `exports`.
- Configuration: `agent-quorum.json`, `src/core/config.ts`,
  `docs/configuration.md`.
- Orchestration: `src/core/*`, `docs/architecture.md`.
- Providers and watchdogs: `src/providers/*`, `src/runtime/*`.
- Role skills and schemas: `skills/**/SKILL.md`, `skills/**/*.schema.json`.
- Self-planning dogfood: the `plan:self` package script (`agent-quorum` from source).

Every claim about existing code carries `file:line`. Every claim about behavior
carries a source: docs, config, tests, or a prior operator statement. Anything
not verified is an assumption.

### Step 3 — Draft the requirements skeleton

Draft the document using the **Document contract** below:

- context;
- problem;
- goals;
- functional requirements (`FR-n`, each with Must/Should/Could priority and a
  one-line rationale);
- non-functional requirements (`NFR-n`);
- out-of-scope items;
- acceptance criteria (`AC-n`, each mapped to the FRs it verifies);
- risks and assumptions;
- defaults taken;
- decision log.

Each requirement is outcome-level and testable: an observer can decide
pass/fail without knowing how it will be implemented.

### Step 4 — Resolve forks with the operator

This loop is mandatory unless the input already answers every material fork and
the final report justifies why no clarification was needed.

Sweep forks in this order:

1. Scope: what is in/out.
2. Behavior: observable outcomes and edge cases.
3. Priority: Must vs Should vs Could.
4. NFR thresholds: runtime, determinism, output shape, compatibility, locale.
5. Compatibility: public API, CLI flags, config, schemas, generated artifacts.
6. Rollout and verification: tests, docs, release impact.

Use the current runtime's structured question tool when available. Batch up to
4 questions per round. Each question has 2-4 mutually exclusive options with
one-sentence consequences; put a grounded recommendation first and mark it
`(Recommended)`. If the structured tool is unavailable, ask the same questions
in plain chat.

Record every resolved fork as `D-n`.

### Step 5 — Finalize and validate

Quality gates:

- Every FR/NFR is testable, outcome-level, and solution-free.
- Every material fork is resolved in the decision log or explicitly deferred
  with owner and reason.
- Every AC maps to at least one FR; every Must FR has at least one AC.
- Facts carry evidence; assumptions are labeled; defaults taken are listed.
- The document stands alone without this conversation.

### Step 6 — Save and operator sign-off

Save the document to `.agents/requirements/<slug>.md` under the repository root.
Create the directory if absent. On slug collision append `-2`, `-3`, etc.;
never overwrite.

Present a summary in the operator's conversation language with goals,
compressed FR list, resolved forks, defaults taken, deferred items, and saved
path. Then ask for sign-off:

- approve and hand off to `/solution-handoff`;
- approve only;
- revise.

On approval set `Status: approved`. If the structured question tool is
unavailable, ask in plain chat and keep `Status: draft` until explicit approval.

### Step 7 — Handoff to solution-handoff

On "approve and hand off", invoke `/solution-handoff` with a dossier framed from
the approved requirements document and pass the document path. The handoff must
preserve the problem, approved scope, decisions, acceptance criteria, open
items, and the originating issue reference (the `Issue:` field) without adding an
implementation solution. `/solution-handoff` then delegates prompt composition to
`/prompt-architect`.

On "approve only", report the saved path and the manual continuation:

```text
/solution-handoff approved requirements in <path>
```

## Document contract

The saved document is English. Operator questions and summaries use the
operator's conversation language. Identifiers, paths, and verbatim quotes stay
as-is.

```markdown
# <Title>

- Status: draft | approved
- Date: <YYYY-MM-DD>
- Source: raw request | harvest (<which upstream>) | cold call
- Issue: <org/repo#n when the work originates from or will resolve a GitHub issue, else none>
- Target repository: agent-quorum

## Context

<product/developer surface, relevant existing behavior, facts with evidence>

## Problem

<what is wrong or missing, in outcome terms; hypotheses labeled>

## Goals

<what becomes true for users/operators/maintainers when this ships>

## Functional requirements

FR-1 (Must): <testable outcome>. Rationale: <one line>.
FR-2 (Should): ...

## Non-functional requirements

NFR-1: <threshold/quality with a concrete bound and source>

## Out of scope

<explicit exclusions>

## Decision log

D-1: <fork> — options: <A / B>; operator chose <A> (<why, if stated>).

## Defaults taken

<low-impact choices the agent made; each one line>

## Acceptance criteria

AC-1 (covers FR-1): <observable check>

## Risks & assumptions

<assumptions awaiting validation; risks with the FR they threaten>

## Open items

<deferred forks with owner and reason; empty if none>
```

## Invariants

1. No solutions in FRs, NFRs, or ACs.
2. Operator resolves material forks.
3. Grounded facts carry `file:line`, doc/config/test evidence, or operator
   source.
4. Every FR and AC is decidable pass/fail by observation.
5. The document alone is the downstream contract.
6. Artifact language is English; operator interaction follows the operator's
   conversation language.
7. `/solution-handoff` owns the next handoff step; `/prompt-architect` owns
   prompt composition and launch confirmation.

## Edge cases

- **Cold call**: ask for the task first.
- **Already formalized input**: validate, run one light fork sweep, save.
- **Harvest mode**: use the investigation dossier for context/problem evidence;
  requirements work focuses on goals, scope, and acceptance.
- **Scope spans unrelated surfaces**: propose splitting into separate
  requirements documents.
- **Operator answers conflict**: surface the contradiction and re-ask.
- **Operator unavailable**: save as draft with unresolved forks in Open items.

## Quality check

- Saved under `.agents/requirements/`, no overwrite.
- At least one clarification round ran, or absence is justified.
- Every material fork appears in Decision log or Open items.
- Every Must FR has an AC.
- No FR/NFR/AC contains a solution.
- Facts evidenced, assumptions labeled, document self-sufficient.
