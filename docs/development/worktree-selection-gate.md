# Worktree selection gate

This document is the single source of truth for the worktree selection gate: the
upfront protocol a working-tree-dependent skill runs to target the right session
worktree before it acts. The protocol is defined once here (FR-9) and adopted by
reference; each gated skill carries a byte-identical `## Worktree selection gate`
section that wires it in, rather than re-implementing the rules per skill.

The gate consumes the per-session worktree model from
`session-isolated-delivery-via-worktrees`; it does not define worktree creation,
naming, location, or the durable task-description record. It changes skill-flow
behavior only: no public API, CLI bin, configuration, or schema contract changes
(NFR-2). `--worktree` is a skill-prompt argument, not an `agent-quorum` CLI flag.

## Scope

Gated skills (FR-1): `tidy`, `ship`, `execute`, and any future skill that reads
or mutates a checkout's working tree. Each resolves its target worktree before
any working-tree action.

Agnostic skills (FR-10): `issues`, `requirements`, and `solution-handoff` never
present the gate, because they produce documents from conversation and read-only
inspection and never act on a working tree. `prompt-architect` is also not gated;
its `plan:self` runs are excluded by D-1.

## Dependency and single-worktree no-op

The gate depends on the per-session worktree isolation capability
(`session-isolated-delivery-via-worktrees`) landing first (NFR-1). Until then the
repository has a single working tree, so the gate has no observable behavior: the
unambiguous-skip rule (FR-5) applies and every gated skill proceeds in place. The
multi-worktree runtime path activates only once concurrent sessions run in their
own worktrees.

## Candidate discovery

Enumerate candidate worktrees with their branches and paths:

```sh
git worktree list --porcelain
```

Identify the invocation worktree with `git rev-parse --show-toplevel`, and tell
the primary checkout from a linked worktree by comparing
`git rev-parse --git-common-dir` with `git rev-parse --git-dir` (they resolve to
the same directory in the primary checkout and differ in a linked worktree).
Inspect any non-selected candidate read-only with `git -C <path> ...`; never
mutate a candidate during discovery.

## Unambiguous-skip rule (FR-5)

Present no menu and proceed on the current tree when the target is unambiguous:

- exactly one candidate worktree exists, or
- the skill is invoked from inside a linked session worktree (the invocation
  `git rev-parse --show-toplevel` matches a candidate session worktree).

The primary checkout is treated as a dispatch context, not a selectable
candidate: when a skill is invoked there and one or more linked session worktrees
exist, present the menu rather than skipping. A skill always runs inside some git
worktree, so a literal "inside any worktree" skip would make the gate a permanent
no-op; this reading refines the wording of FR-5 and AC-1.

## Explicit target: `--worktree <branch|path>` (FR-8)

`--worktree <branch|path>` selects the target directly and bypasses the
interactive menu only. Resolve it before acting:

- canonicalize a path argument (expand `~`, resolve to an absolute path,
  `realpath`) and match it, or match a branch name, exactly against
  `git worktree list --porcelain`;
- stop and ask the operator on zero matches or more than one match rather than
  guessing a target;
- display the resolved branch and path before proceeding.

An explicit target bypasses the menu only. It does not bypass the active-edit
evaluation or the confirmation in FR-7.

## Option content (FR-2, FR-3)

When the menu is shown, present every candidate worktree and act only on the one
the operator selects (FR-2). Each option identifies its worktree two ways at once
(FR-3):

- its stable git identifier — branch and path, shown verbatim (NFR-3);
- a human-meaningful task description, or an explicit
  `(no task description recorded)` indicator when none exists; and
- an active-edit marker (see below).

## Durable per-worktree record (FR-4)

The task description is read from a durable per-worktree record the operator
populates when the worktree is created (FR-4). A worktree with no recorded
description still appears as an option, showing its git identifier and the
explicit missing-description indicator rather than being omitted.

The record is `agent-quorum-task.md` inside the worktree's git admin directory,
located with `git -C <path> rev-parse --absolute-git-dir` (the same admin dir the
primary/linked distinction above already computes). Every worktree created through
`pnpm run worktree:create` writes this record, so the in-flow path always carries a
description; the gate consumes it through that admin dir, keyed by worktree path or
branch. When the file is absent — a worktree created outside the `worktree:create`
flow — fall back to the git-only behavior and show the
`(no task description recorded)` indicator.

## Active-edit signal (FR-6, NFR-4)

Each option surfaces whether another session may currently be editing its
worktree (FR-6). The signal is conservative (NFR-4): when session attribution is
unavailable or uncertain, indicate possible live editing rather than asserting
the worktree is idle. Resolve it through this fallback chain:

1. the per-session active-edit marker `agent-quorum-active-edit.json` in the same
   git admin directory, read as active when `now - refreshedAt <= ttlSeconds`
   (default 900); a missing, stale, or unreadable marker falls through to the next
   step rather than reading idle;
2. otherwise a dirty working tree (`git -C <path> status --porcelain`) or a
   locked worktree, used as a "possibly being edited" proxy;
3. otherwise, since git carries no per-session attribution, surface uncertainty
   (`active editing cannot be confirmed or ruled out`) instead of reporting idle.

## Confirmation on an actively-edited target (FR-7)

Selecting a worktree marked as possibly edited by another session requires
explicit operator confirmation before the skill performs any action (FR-7). This
applies whether the worktree was chosen from the menu or passed with
`--worktree`.

## Worktree handoff

After the target is resolved, operate inside it:

- enter the selected worktree (the host `EnterWorktree` tool, or `cd` to its
  path);
- confirm `git rev-parse --show-toplevel` equals the selected worktree path
  before any git, file, or verification command;
- run every subsequent skill action inside the selected worktree, and reserve
  `git -C <path>` for read-only inspection of other candidates;
- stop if the handoff cannot be confirmed, because acting could mutate the wrong
  tree.

## `execute` plan-path anchoring

`execute` resolves and reads its `<plan-path>` argument against the invocation
checkout (absolute, `~`, or repository-root-relative to where the operator
invoked the skill) before entering the selected worktree. It then performs the
implementation and writes the execution journal inside the selected worktree.
Stop if the plan path cannot be resolved or read against the invocation checkout
rather than re-resolving it against the selected worktree.

## Presentation

Use the host structured-question tool (`AskUserQuestion`) when available, falling
back to a plain-chat numbered list. Selection prose is in the operator's
conversation language, while git identifiers (branch, path) are shown verbatim
(NFR-3).

## Consistency (FR-9)

The protocol body lives only in this document. Each gated skill embeds a
byte-identical `## Worktree selection gate` section that references this file,
plus a skill-specific wire-in clause at its existing checkout-resolution step.
Skill-specific nuances, such as the `execute` plan-path anchoring above, live in
this document and in the per-skill wire-in clause, not in the shared section, so
the shared section stays identical across `tidy`, `ship`, and `execute`.
