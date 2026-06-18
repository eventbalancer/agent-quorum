---
name: solution-handoff
description: Convert a completed agent-quorum investigation or approved requirements document into clustered, problem-describing handoff prompts without prescribing the implementation solution.
---

# solution-handoff

Bridge a completed investigation or an approved requirements document into a
systemic solution handoff for `agent-quorum`. Instead of proposing and starting
a fix inline, this command harvests the context into self-contained,
problem-describing prompt requests and hands them to `/prompt-architect`.

The prompts carry context, not a ready-made solution. This command is a
handoff, not a solver.

- Upstream: ad-hoc debugging, review, audit, failed test investigation.
- Upstream: `/requirements` when product or public-contract forks were resolved
  first.
- Downstream: `/prompt-architect` -> confirmed `plan:self` self-planning run ->
  implementation.
- Optional intermediate: `/requirements` when the fix raises product-level or
  public-contract forks that need operator decisions.

Follow the repository-root `AGENTS.md` / `CLAUDE.md` operating rules and
`docs/development/conventions.md`.

## Arguments

```text
/solution-handoff
/solution-handoff <refinement>
/solution-handoff approved requirements in <path>
```

`$ARGUMENTS` is optional. It can refine scope, grouping, output language, or
delivery constraints. Empty arguments mean work from the investigation already
in the conversation. A requirements path means use the approved document as the
primary dossier.

## Philosophy

Prompts describe the problem, never the solution. They include verified
findings, symptoms, root causes with `file:line`, evidence, and open questions.
The downstream agent re-verifies findings against the live repository and
designs the fix.

## Trigger

Invoke from a completed investigation when all three hold:

- investigation is essentially complete;
- root causes are backed by code/log/test references;
- the problem is non-trivial and deserves systemic design.

Do not invoke for one-line fixes, cosmetic tasks, or when no root cause has been
confirmed. Invoke from `/requirements` once the document is approved. With no
investigation context or requirements document, decline cleanly.

## Inputs — harvest, do not re-investigate

Collect only what is already in the conversation:

- symptoms in the user's words and observed behavior;
- every distinct defect;
- per defect: root cause with `file:line`, plus evidence;
- affected `agent-quorum` surfaces: CLI, API, config, core loop, providers,
  runtime, skills/schemas, docs, tests;
- hypotheses, explicitly labeled;
- related symptoms already patched in the session;
- open questions the designer must answer;
- the GitHub issue the work is tracked under, if any, as an `<org/repo#n>`
  reference.

For an approved requirements handoff, collect from the document instead:

- approved scope, decisions, functional requirements, acceptance criteria, and
  open items;
- evidence and assumptions recorded in the document;
- the originating issue reference (the document's `Issue:` field), so the
  eventual commit or PR can close it;
- the requirement document path, so `/prompt-architect` can instruct the next
  agent to read it in full.

## Instructions

### Step 0 — Mark originating issue in progress

If the investigation or approved requirements document carries an originating
GitHub issue, move that issue's project-board item to `In Progress` before
building or delegating handoff prompts. Use GitHub through `gh`: discover the
repository's linked ProjectV2 board with `gh api graphql`, add the issue item if
it is absent, resolve the `Status` single-select field and the `In Progress`
option with `gh project field-list`, then set the item with
`gh project item-edit`. If several linked projects exist, ask the operator which
board to use before continuing. If `gh`, the linked board, `Status`, or
`In Progress` is unavailable, stop and report the blocker instead of continuing
to work the issue without the board transition.

### Step 1 — Build the investigation dossier

Assemble a structured block from the inputs above. Record confirmed facts only;
mark unconfirmed material as hypothesis. Invent no findings absent from the
conversation. If there is no investigation context, stop and decline.

### Step 2 — Strip ready-made solutions

Remove concrete candidate edits, names of future entities, and chosen
approaches. Keep problem, root causes, evidence, constraints, and open
questions.

### Step 3 — Cluster the problems

Group defects into the smallest sufficient number of related clusters, biased
toward merging. Produce a short rationale per cluster.

Split only when clusters are genuinely independent: different subsystem, no
shared root cause, no file overlap, no ordering dependency, and a single prompt
would be artificially broad.

Strong relatedness signals:

- shared root cause or mechanism;
- same subsystem/layer (`cli`, `core`, `providers`, `runtime`, `skills`, docs,
  tests);
- overlapping files or contracts;
- one public API/CLI/config/schema compatibility theme;
- safer as one coherent change.

### Step 4 — Compose one prompt per cluster via prompt-architect

For each cluster, delegate composition to `/prompt-architect`. Pass the cluster
dossier, the originating issue reference, and a result contract. Do not copy
prompt-architect's XML rules here.

Result contract per cluster:

- downstream agent re-verifies the findings;
- designs a systemic but scoped fix;
- preserves public API/CLI/config/schema compatibility unless the prompt
  explicitly authorizes breaking change;
- updates tests/docs/contracts as required;
- leaves the project in a green state.

### Step 5 — Save prompts

`/prompt-architect` saves prompts under `.agents/prompts/`, emits run
profiles, and owns the only launch confirmation step. Ensure each slug carries
its cluster label (`<topic>-<cluster>.md`) and that related cluster slugs share
a common stem.

### Step 6 — Report to the operator

Present:

- clustering with per-cluster rationale;
- saved prompt paths;
- downstream explanation: `/prompt-architect` will present run profiles and ask
  for confirmation before starting `agent-quorum`;
- whether the handoff came from investigation context or approved requirements.

Generating prompt requests for `/prompt-architect` is the deliverable. Running
`agent-quorum` happens only inside `/prompt-architect` after explicit operator
confirmation.

## Clustering rules

- One problem -> one prompt.
- Many related problems -> one prompt.
- Many small problems -> usually one prompt, not one prompt per item.
- Multiple independent public contracts -> separate prompts.
- When in doubt, merge related items; do not merge genuinely unrelated items to
  shrink the count.

## Prompt contract

- One prompt per cluster.
- Each prompt carries its cluster's full problem context.
- No prompt contains the author-agent's concrete solution.
- Each prompt includes a constraint that downstream findings must be
  re-verified against the live repository.

## Invariants

1. No ready-made solutions.
2. Every code claim carries `file:line`; every behavior claim carries
   log/test/doc/operator evidence.
3. Every found defect reaches a prompt or is explicitly scoped out.
4. Prompts require skepticism of premise and re-verification.
5. Prompts ask for systemic but scoped design.
6. Artifacts are English; operator messages use the operator's conversation
   language.
7. `/prompt-architect` owns prompt XML and run-profile formatting.
8. Every handoff carries the originating GitHub issue reference, or notes that
   none applies, so delivery can close it.

## Output artifacts

- Prompt requests delegated to `/prompt-architect`, which saves prompt files
  under `.agents/prompts/`.
- `/prompt-architect` emits run profiles that execute:

```text
AGENT_QUORUM_WORK_DIR=<workdir> pnpm run plan:self -- --quality <quality> --iters <n> --prompt <prompt-path>
```

Run artifacts should use distinct workdirs under `.agents/plans/`. Do not start
these commands from `solution-handoff`.

## Edge cases

- **No investigation context or requirements document**: state that an
  investigation or approved requirements document must come first.
- **One defect**: one cluster, one prompt.
- **Many small related defects**: group them.
- **Partially traced cause**: carry as hypothesis.
- **Conflicting facts**: flag the contradiction; do not smooth it over.
- **Product-level fork**: hand off to `/requirements` first, then resume this
  command after approval.

## Quality check

- Prompt count equals cluster count.
- Each cluster has a rationale.
- No prompt carries concrete edits or chosen implementation.
- Every finding has evidence or is labeled hypothesis.
- Each prompt includes skepticism of premise.
- Saved paths are reported as resolved absolute paths.
- Run profiles and launch confirmation are handled only by `/prompt-architect`.
