---
name: issues
description: Harvest the current agent-quorum session for potential improvement and fix directions, cluster them, and create proposal-level GitHub issues that feed the delivery flow. Use when the operator asks to run /issues, capture follow-ups from this conversation as issues, file what we found as GitHub issues, or turn session insights into tracked proposals.
---

# issues

Read the current conversation, surface every potential direction for
improvement or fix that came up, cluster the related ones, and — after operator
confirmation — open one proposal-level GitHub issue per cluster. This is the
front door of the delivery cycle: each issue is a durable placeholder for a
future product flow, never a spec and never a solution.

- Upstream: an agent session that uncovered follow-ups, deferred work, gaps, or
  ideas while doing something else (investigation, review, feasibility chat,
  implementation).
- Downstream (later, per issue, not here): `/requirements` ->
  `/solution-handoff` -> `/prompt-architect` -> confirmed self-planning run.

This skill never starts `agent-quorum` and never edits the checkout. Its only
side effects are creating GitHub issues and adding them to the repository's
project board, and both happen only after the operator confirms.

Follow the repository-root `AGENTS.md` / `CLAUDE.md` operating rules and
`docs/development/conventions.md`.

## Arguments

```text
/issues
/issues <focus or filter>
```

`$ARGUMENTS` is optional. Empty arguments means harvest the whole current
session. A focus argument narrows the harvest to a theme, surface, or subset
(for example a single subsystem, or "only docs/test gaps").

## Philosophy

An issue created here captures **what is worth doing and why**, never **how to
do it**. It is the seed of the product flow, so it must survive being read by
someone who was not in this conversation and must not bias the later
`/requirements` step toward any approach.

Each issue therefore states the opportunity or problem in outcome terms and
stops there. The clustering follows `/solution-handoff` discipline: merge
related directions into the smallest useful set, strip candidate edits and
future entity names, and route product-level ambiguity to the later flow rather
than resolving it inline.

The operator decides what gets filed. The agent proposes the clustered set; it
does not create issues unprompted.

## Workflow

### Step 1 — Harvest the session

Re-read the current conversation and collect every potential direction for
improvement or fix, including:

- follow-ups the operator or agent explicitly deferred ("later", "revisit",
  "TODO", "out of scope for now");
- problems, defects, or risks surfaced during work but left unaddressed;
- gaps in rules, docs, tests, scripts, or architecture noted in passing (the
  `CLAUDE.md` Self-Improvement signal);
- ideas or proposals discussed but not acted on.

Ground every candidate in something actually said or found in this session. Do
not invent directions the conversation does not support. If a focus argument was
given, keep only candidates matching it.

### Step 2 — Cluster

Group related candidates into the smallest useful set of coherent directions —
one prospective issue per cluster. Merge near-duplicates and tightly coupled
items; split only when two directions would each need their own product flow.
Drop one-off, already-resolved, or trivially-actionable items (note them in the
report instead of filing them).

### Step 3 — De-duplicate against existing issues

Before proposing anything, check the tracker so nothing is filed twice:

```bash
gh repo view --json nameWithOwner -q .nameWithOwner
gh issue list --state open --limit 100 --json number,title,labels
```

For each cluster, match against open issues by intent, not just wording. If a
cluster already has an issue, drop it from the create set and reference the
existing number in the report. If `gh` is unavailable or the repo has no GitHub
remote, stop and report that to the operator instead of guessing.

### Step 4 — Draft each issue

Draft every surviving cluster against the **Issue contract** below. Keep each
issue proposal-level and solution-free. Pick one label per issue from the
repository's existing label set (commonly `enhancement`, `bug`,
`documentation`, `question`); do not create new labels.

### Step 5 — Propose and confirm

Present the clustered set to the operator in the operator's conversation
language: for each prospective issue show the title, the one-line summary, and
the chosen label, plus any clusters dropped as duplicates (with the existing
issue number) or as out-of-scope.

Then ask for confirmation using the host's structured question tool when
available. Offer at least:

- create all proposed issues;
- create a chosen subset;
- revise titles/clusters first;
- create none.

Do not create any issue before the operator confirms. If the structured tool is
unavailable, ask in plain chat and treat creation as pending until explicit
approval.

### Step 6 — Create, add to the board, and report

On approval, create each confirmed issue:

```bash
gh issue create --title "<title>" --label <label> --body "<body>"
```

Then add every created issue to the repository's kanban board so it enters the
delivery cycle in the backlog column. First discover the project linked to the
repo:

```bash
gh api graphql -f query='
query($owner:String!,$name:String!){
  repository(owner:$owner,name:$name){
    projectsV2(first:10){nodes{id number title}}
  }
}' -F owner=<owner> -F name=<repo>
```

Board placement rules:

- If exactly one project is linked, use it. If several are linked, ask the
  operator which board to use. If none is linked, skip the board step, note it
  in the report, and suggest creating a project — do not fail the issue
  creation.

For each created issue, add the item and move it to the backlog column:

```bash
gh project item-add <number> --owner <owner> --url <issue-url>
gh project field-list <number> --owner <owner> --format json
gh project item-edit --id <item-id> --project-id <project-id> \
  --field-id <status-field-id> --single-select-option-id <backlog-option-id>
```

Resolve `<item-id>` from `gh project item-list <number> --owner <owner>
--format json`, and `<status-field-id>` / `<backlog-option-id>` from the
`Status` single-select field returned by `field-list` (the backlog option is
commonly named `Todo`). If the board has no such `Status` field, add the item
without setting a column and note it in the report.

Report the created issue URLs, their board placement, and any skipped/duplicate
clusters in the operator's conversation language. Do not stage, commit, push,
open PRs, or start `agent-quorum`.

## Issue contract

The issue title and body are written in English (committed/external artifact).
Operator interaction stays in the operator's conversation language. Titles are
concise outcome statements, lowercase after the first word, no trailing period.

```markdown
## Summary

<one or two sentences: the opportunity or problem in outcome terms>

## Motivation

<why this is worth revisiting: the value if addressed or the cost if ignored>

## Context

Surfaced during an agent session on <YYYY-MM-DD>. <one line on what prompted it>.

## Area (orientation only)

<coarse subsystem or surface this touches, as a pointer — not a design>

## Next step

This is a proposal placeholder, not a specification. Before any implementation,
route it through the delivery flow:

`/requirements` -> `/solution-handoff` -> `/prompt-architect` -> confirmed
self-planning run.

Use the shortest chain that still preserves the needed decision boundary.
```

## Boundaries

- The issue body contains **no implementation details**: no chosen approach, no
  candidate edits, no code snippets, no `file:line` references, no named future
  entities, no effort or time estimates.
- Do not file directions the session does not actually support.
- Do not duplicate an existing open issue; reference it instead.
- Do not create issues before the operator confirms.
- Do not invent labels; reuse the repository's existing set.
- Do not edit the checkout, stage, commit, push, open PRs, or start
  `agent-quorum`. The only side effects after confirmation are `gh issue create`
  and adding the created issues to the linked project board.

## Output

End with this checklist:

```text
Harvested: <n> candidate directions from this session
Clustered into: <m> prospective issues

Created:
  - #<n> <title> (<label>) -> <url> [board: <project> / <column>]

Skipped:
  - <cluster> -> duplicate of #<n>
  - <cluster> -> out of scope: <reason>

Not run:
  - <reason, e.g. gh unavailable / no project linked / operator created none>
```
