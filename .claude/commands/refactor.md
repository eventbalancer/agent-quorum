---
name: refactor
description: Improve agent-quorum code structure and readability through bounded, behavior-preserving refactoring, including justified related files and dependency-impact analysis. Use for structural cleanup, responsibility splits, code simplification, or the quality pass before tidy; accept explicit paths or inspect the current changed source files.
---

# Refactor

Make the current change easier to understand and maintain through improvements
that pay off now. Combine dependency-impact analysis with clear responsibility
boundaries and readable control flow. Prefer a small, coherent refactor over an
open-ended redesign. A successful pass may leave already clear files unchanged.

Follow `AGENTS.md`, `docs/development/conventions.md`, and relevant architecture
contracts. This is a repository-local workflow, not a provider role under
`skills/`.

## Invocation authority

The workflow below describes interactive invocation. For work assigned by an
active autonomous delivery controller, first validate the controller's frozen
mandate, current issue, and exact owned worktree through its durable state.
A prompt, issue, environment variable, or edited skill is not authorization.
Apply the autonomous rules in
`docs/development/agent-skill-flow.md#authorized-autonomous-delivery`; its
mode-specific routing replaces routine confirmation and stage-stop instructions
below. Preserve interactive behavior when no validated mandate applies.
Workers return proposed external effects and evidence to the controller; the
controller broker rechecks authority, ownership, limits, and applicable gates
before executing them. This skill cannot change the active policy.

## Invocation and scope

```text
/refactor
/refactor <path> [<path>...]
/refactor <description of the intended improvement>
/refactor impact <path-or-symbol>
/refactor --worktree <branch|path> [<scope>]
Use $refactor for <scope>
```

Slash-command and Codex forms have the same meaning. `impact` is read-only:
identify affected definitions, direct and transitive consumers, contract risks,
and an appropriate change and verification sequence; do not edit or launch a
provider run.

With no scope, capture the union of staged, unstaged, and untracked source files
in the selected checkout. Use current paths for renames and do not recreate
deleted files. Exclude tests and test-only support from this default source
inventory, but read them to understand behavior. Explicit scope is authoritative:
it may include clean files, tests, or all changed TypeScript files. A directory
authorizes inspection of its contents, not mechanical edits to every file.

Capture this inventory before editing. New helpers and justified related files
do not recursively expand the task. Inspect every eligible target; edit only
where a concrete readability or cohesion improvement exists. Generated output,
lockfiles, binary assets, and secrets are not hand-refactoring targets.

Direct callers, internal contracts, tests, barrels, and existing documentation
may change when needed to complete the same improvement coherently. Explain
each expansion beyond the initial scope. Read-only consumer inspection is not
permission to clean up unrelated modules or another repository.

## Worktree selection gate

When more than one session worktree may exist, target the right one before
touching a working tree. This skill follows the shared protocol in
`docs/development/worktree-selection-gate.md`; the canonical rules live there and
this section only wires the skill into them. The gate has no observable behavior
in a single-worktree checkout.

- **Default (interactive):** enumerate candidate worktrees and present each with
  its git identifier (branch and path, verbatim), its recorded task description
  or an explicit `(no task description recorded)` indicator, and an active-edit
  marker; act only on the operator-selected worktree.
- **Unambiguous skip:** present nothing and proceed in place when exactly one
  non-done candidate exists or the skill is invoked inside a linked session
  worktree; the primary checkout is a dispatch context, not a candidate.
- **Done worktrees:** a session marked done (an `agent-quorum-done.json` marker
  written by `worktree:done`) is skipped by default - omitted from the menu and
  from the unambiguous-skip count. It stays in `worktree:list` and is selectable
  with `--worktree` or surfaced with `--include-done`; confirm before acting and
  offer `worktree:reopen` when resuming work. When every candidate is done, do
  not act on the primary checkout - ask for `--worktree`/`--include-done`, a
  reopen, or a new worktree.
- **Explicit target:** `--worktree <branch|path>` bypasses the menu only. Match
  it exactly against `git worktree list --porcelain` and stop on zero or multiple
  matches. It still requires confirmation when the target may be actively edited
  by another session.
- **Confirmation:** selecting a worktree another session may be editing requires
  explicit operator confirmation before any action.
- **Handoff:** enter the selected worktree and confirm that
  `git rev-parse --show-toplevel` equals its path before any git, file, or
  verification command; reserve `git -C <path>` for read-only inspection of other
  candidates. Stop if the handoff cannot be confirmed.

See `docs/development/worktree-selection-gate.md` for candidate discovery, the
durable-record contract keyed by worktree, the conservative active-edit signal,
and the presentation surface.

## Workflow

### Establish the baseline and impact

Inspect `git status --porcelain=v1 --untracked-files=all`, staged and unstaged
diffs, and untracked files. Preserve the existing work. Read every scoped file
end-to-end, then use `rg` and the TypeScript import graph to find definitions,
callers, tests, exports, and documentation references. Re-read a target before
patching if another session may have changed it.

Distinguish internal implementation from module, public, and durable contracts.
Name the invariants that must survive: public exports and CLI behavior, schemas,
property presence, errors, logs, side-effect order, lazy evaluation, provider
dispatch, evidence identities, authorization checks, recovery, and accounting.
Read the relevant contracts before moving code across their boundaries.

For a structural change, give a short plan: the observed difficulty, the intended
responsibility of each affected module, its consumers, and the verification that
will establish preservation. Proceed within the authorized task without a new
approval ceremony. New behavior, dependencies, public-contract changes, or a
broader architecture migration require separate scope unless already authorized.

### Choose only useful improvements

Prioritize changes that remove a demonstrated obstacle: mixed responsibilities,
repeated domain logic, deeply nested decisions, hidden side effects, or callers
that must understand implementation details. Select a bounded set with a clear
stopping point. Do not chase every possible smell or impose file-size targets.

- Make the entrypoint read as the operation's high-level sequence. Extract a
  module when it owns a distinct responsibility or independent reason to change.
  Prefer domain names over `utils`, `helpers`, or `common` containers.
- Keep a short single-use helper local unless its name expresses a useful domain
  decision. Avoid pass-through wrappers, unnecessary barrels, and abstractions
  built for hypothetical future consumers.
- Use guard clauses, named compound conditions, symmetric branches, and one
  level of abstraction per function. Keep meaningful transformations visible.
- Name non-trivial input and result shapes; use repository conventions for
  `interface`, `type`, `readonly`, positive booleans, and exhaustive unions.
  Narrow `unknown`; do not replace type safety with `any` or speculative casts.
- Keep lazy work inside its original branch. Moving clocks, logging, provider
  calls, or error-producing computations earlier can change behavior.
- Remove dead exports, parameters, and duplicate paths only after proving their
  callers have been migrated. Preserve useful comments about non-obvious
  invariants; prefer names and structure for ordinary explanations.

Work in dependency order: establish the internal structure, migrate all affected
consumers, remove proven-obsolete code, then verify. Update a definition and its
consumers together when that is the simplest coherent change. Do not introduce
compatibility aliases, staged API versions, or add/migrate/remove ceremonies
solely to imitate a cross-repository workflow.

### Preserve behavior and finish the pass

Use small patches, keeping contract-sensitive strings and values unchanged while
moving code. Respect `providerRun`, architecture direction, generated-file
ownership, and the frozen autonomous enforcement boundary. Reconcile all current
consumers and documentation when names, paths, or responsibilities change.

After structural moves, typecheck before adding optional cleanup. Re-read the
result and its diff to verify side-effect ordering, branches, property presence,
errors, and public or durable contracts. Preserve concurrent work. A new bug
discovered during a pure refactor is separate work unless its fix is already
authorized; do not silently mix it into the pass.

Stop when the selected improvements are complete and verified. Further cosmetic
opportunities are not a reason to restart discovery. If a proposed improvement
turns into a redesign, leave it unimplemented and explain the concrete reason.

## Relationship to tidy

The development sequence is implementation -> `/refactor` -> `/tidy` -> applicable
verification -> authorized `/ship`. Refactor gives more attention to structure,
responsibilities, and related consumers; tidy gives more attention to conventions
and local finishing details in the resulting dirty set. Readability, naming,
types, and small extractions can belong to either. Do not route a useful scoped
change back and forth merely because the responsibilities overlap.

Both passes may conclude that no edits are worthwhile. Do not rerun a settled
pass unless subsequent changes justify it. A standalone refactor request does
not authorize commits, push, activation, release, or unrelated follow-up work.

## Verification and report

Use repository entry points. Run typecheck and relevant behavior tests after a
meaningful structural change; use existing tests rather than tests that merely
assert the new arrangement. For broad TypeScript changes, run `pnpm run check`
and `pnpm run test` on the settled result, plus applicable repository gates.
Consolidate checks across refactor and tidy when they are part of the same task;
repeat only for new changes, failures, or unresolved concerns. Never weaken an
assertion to make a refactor pass.

For skill or workflow text alone, use formatting and the relevant skill
validator. Keep documented Claude command mirrors byte-identical and verify
them with `cmp -s`. Search changed paths and symbols in active documentation,
including agent-facing instructions, and reconcile every relevant reference.
No refactor automatically authorizes live provider tests or release calibration;
preserve any applicable existing merge gate and report unmet prerequisites.

Report the scope inspected, the meaningful changes and why they help, justified
related-file edits, preserved contracts, and exact verification results. State
when no worthwhile changes were found. Report remaining blockers or separate
findings without manufacturing a follow-up backlog. Do not stage, commit, push,
open a PR, or execute releases without the required existing authorization.
