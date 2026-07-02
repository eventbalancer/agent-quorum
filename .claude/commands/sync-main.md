---
name: sync-main
description: Rebase a session worktree branch onto the latest origin/main, resolve conflicts with a source-of-truth bias, force-push with lease, and actualize the linked PR. Use when the operator asks to run /sync-main, rebase or update a branch/worktree onto main, resolve rebase conflicts, force-push a rebased branch, or refresh the linked PR after a rebase.
---

# sync-main

Bring one `agent-quorum` session branch - and its worktree and linked PR - up to
date with `origin/main` by rebasing, resolving conflicts deliberately,
force-pushing with lease, and actualizing the PR. This rewrites history: it is
the history-rewriting counterpart to `/ship`, which only appends commits. Land
any dirty work with `/ship` first; this skill refuses to run on a dirty tree.

Follow `AGENTS.md` and `docs/development/conventions.md`. Use git, `pnpm`, and
`gh` directly. Never push, force-push, or change PR state without showing the
exact irreversible plan first; a plain `/sync-main` is intent to rebase and
force-push the current session branch, but still print the plan before the
force-push and the PR edits.

## Boundaries

- Rebase only. Never merge `main` into the branch, never `git pull`, never
  `--abort` an in-progress rebase, and never `git reset --hard` / `git clean`
  unless the operator explicitly asks.
- Force-push only with `--force-with-lease`, never a bare `--force`.
- Operate inside the target worktree. Run every git, file, and verify command
  there; do not assume a persistent shell working directory between commands -
  pass absolute paths or re-enter the worktree each time.
- Preserve the public contract and architecture boundaries while resolving: the
  registry is the single source of truth for runner wiring, `core/` does not
  spawn provider CLIs, and lower layers do not import higher layers.
- Committed artifacts stay in English. Report resolved absolute paths to the
  operator.

## Arguments

```text
/sync-main
/sync-main --worktree <branch|path>
/sync-main --onto <ref>        # default: origin/main
/sync-main --dry-run
/sync-main --no-push
/sync-main --no-pr
```

`--dry-run` inspects and prints the plan only. `--no-push` resolves the rebase
but stops before the force-push. `--no-pr` skips PR actualization. Unknown flags
are not passed through: stop, list the accepted arguments, and ask.

## Worktree selection gate

When more than one session worktree may exist, target the right one before
touching a working tree. Follow the shared protocol in
`docs/development/worktree-selection-gate.md`; it is a silent no-op in a
single-worktree checkout.

- Default: enumerate candidate worktrees and present each with its branch and
  path (verbatim), its recorded task description or `(no task description
recorded)`, and an active-edit marker; act only on the operator-selected one.
- Unambiguous skip: proceed in place when exactly one non-done candidate exists
  or the skill runs inside a linked session worktree; the primary checkout is a
  dispatch context, not a candidate.
- `--worktree <branch|path>` bypasses the menu; match it exactly against
  `git worktree list --porcelain` and stop on zero or multiple matches.
- Handoff: enter the selected worktree and confirm `git rev-parse
--show-toplevel` equals its path before any action. Reserve `git -C <path>`
  for read-only inspection of other candidates. Stop if handoff cannot be
  confirmed.

## Step 0 - Preflight

Resolve, enter, and verify the target worktree, then run every command inside
it.

```sh
git rev-parse --show-toplevel
git branch --show-current
git status --short --branch --untracked-files=all
```

- The branch should be a `session/*` branch. Confirm with the operator before
  rebasing any other branch, and never rebase `main` itself.
- The working tree must be clean. If it is dirty, stop and tell the operator to
  `/ship` or stash the changes first; do not rebase a dirty tree.
- If a rebase is already in progress, do not start a new one - resume the
  conflict loop in Step 3:

```sh
test -d "$(git rev-parse --git-path rebase-merge)" && echo IN_PROGRESS || echo CLEAN
```

Fetch the base and measure divergence:

```sh
git remote get-url origin
git fetch origin --tags
git rev-parse origin/main
git rev-list --left-right --count HEAD...origin/main   # left = ahead, right = behind
git log --oneline origin/main..HEAD                    # commits to replay
```

If `behind` is 0 the branch is already current: report it, skip Steps 1-5, and
go to the PR step if asked. Optionally reuse conflict resolutions across the
per-commit replay:

```sh
git config rerere.enabled true
```

## Step 1 - Plan

Print the plan and stop in `--dry-run`. Otherwise proceed; pause for explicit
confirmation only before the force-push (Step 5) and the PR edits (Step 6).

```text
WORKTREE   <branch> @ <path>
ONTO       origin/main @ <sha>
REPLAY     <n> commit(s): <oneline list>
DIVERGENCE ahead <a> / behind <b>
PUSH       force-with-lease | skipped (--no-push)
PR         actualize #<n> | none | skipped (--no-pr)
```

## Step 2 - Rebase

```sh
GIT_EDITOR=true git rebase origin/main      # default
GIT_EDITOR=true git rebase <onto-ref>       # when --onto <ref> was given
```

`GIT_EDITOR=true` keeps `--continue` non-interactive by reusing each commit
message. If git applies the commits cleanly, go to Step 4. If it stops on
conflicts, run Step 3 for the stopped commit, then continue; repeat until the
rebase completes. The second session commit can apply cleanly even when the
first conflicted - do not assume every commit conflicts.

## Step 3 - Conflict resolution loop

Resolve each stopped commit with this playbook, then
`GIT_EDITOR=true git rebase --continue`. The goal is a working tree, not just
the absence of markers: never accept a merge that silently drops either side's
behavior.

Understand the sides first. During a rebase, `HEAD` / "ours" is the new base
plus the commits already replayed; "theirs" (the `>>>>>>>` side, labeled with
the commit being replayed) is the incoming session commit; the merge base is
that commit's original parent. Read all three when a region is unclear:

```sh
git show :1:<file>   # base (merge base)
git show :2:<file>   # ours (rebased-onto side)
git show :3:<file>   # theirs (incoming commit)
```

1. Pin the source of truth first. Read the authoritative module before editing
   (for runner wiring that is `src/providers/registry.ts`: `RUNNER_META`,
   `RUNNERS`, `isRunner`, `Runner`). Resolve every related conflict in one
   consistent direction toward it instead of guessing file by file.
2. Resolve in that direction, layering rather than dropping. When both sides own
   overlapping behavior, combine them (for example
   `{ ...resolveRunnerBinaries(), cursor: resolved.providers.cursorBin }`) so
   neither the source-of-truth wiring nor the feature is lost. Surface any real
   contradiction to the operator instead of silently choosing.
3. Prove symbol usage in the merged file before keeping or dropping anything.
   Dead constants from the losing side and now-unused imports must go, or lint
   fails:

   ```sh
   grep -n "<symbol>" <file>
   ```

4. Let consumers decide the winning shape. When the two sides disagree on a type
   or return shape, grep the call sites and pick the shape the consumers
   actually read.
5. Audit auto-merged (non-conflict) files. Git can combine or drop changes with
   no markers. Open the files each side touched around the same regions and
   confirm they are coherent and lost no feature:

   ```sh
   git diff --name-only --diff-filter=U     # files with markers
   git show --stat REBASE_HEAD              # everything the incoming commit touched
   ```

6. Trace signature and API changes to every caller, including files that did not
   conflict. A changed signature breaks unconflicted callers at typecheck time;
   find and adapt them, and stage them into this same commit:

   ```sh
   grep -rn "<changed-symbol>" src tests
   ```

7. Support each decision with `file:line`, a test, or the commit message; label
   anything unverified as a hypothesis.

Finish the commit:

```sh
grep -rn '^<<<<<<<\|^=======$\|^>>>>>>>' src tests   # must print nothing
git add -- <resolved paths> <adapted callers>
git diff --name-only --diff-filter=U                 # must be empty
GIT_EDITOR=true git rebase --continue
```

Isolate-and-verify between commits when a resolution was non-trivial:

```sh
pnpm run types:check
```

When the rebase finishes, confirm the state and the shape of history:

```sh
test -d "$(git rev-parse --git-path rebase-merge)" && echo STILL_REBASING || echo DONE
git log --oneline -6                                 # replayed commits sit on origin/main
```

## Step 4 - Verify

Run the floor before any push:

```sh
pnpm run check
```

If it fails, fix the cause - it lives in the rebased tree regardless of which
commit introduced it - and rerun. If a check cannot run, stop before the
force-push and report the residual risk.

## Step 5 - Force-push

Skip in `--no-push`. Otherwise confirm the plan (this rewrites the remote
branch), then:

```sh
git push --force-with-lease origin <branch>
```

`--force-with-lease` refuses to overwrite if the remote moved since the last
fetch; if it is rejected, re-fetch, re-inspect, and ask before retrying. After a
rebase the branch reads as ahead/behind its old remote - that divergence is
expected, and the force-push reconciles it.

## Step 6 - Actualize the linked PR

Skip in `--no-pr`. Discover the PR for the branch:

```sh
gh pr view <branch> --json number,title,state,isDraft,baseRefName,headRefOid,mergeable,mergeStateStatus,body
```

If none exists, report that and stop. The force-push already updated the PR's
commits; bring the rest into line with reality - do not guess:

- Read the authoritative sources before editing copy: the originating issue
  (`gh issue view <n>`) and the commit message bodies (`git log`). Do not claim
  work that did not happen (for example a version bump the branch did not make).
- Title: update it to describe the branch as it stands; drop stale checkpoint or
  phase qualifiers. Keep the conventional `type(scope): subject` form.
- Body: fetch it to a file, edit the file, and push it back so markdown is not
  mangled:

  ```sh
  gh pr view <n> --json body -q .body > /tmp/pr-body.md
  # edit /tmp/pr-body.md: refresh scope and verification numbers, add a short
  # rebase note, and ensure a closing reference
  gh pr edit <n> --title "<title>" --body-file /tmp/pr-body.md
  ```

- Issue link: include `Closes #<n>` when the branch fully resolves the issue, or
  `Refs #<n>` when it only touches it; mirror the commit-body reference. When it
  is unclear whether it closes, ask the operator.
- Status: mark a complete, green PR ready with `gh pr ready <n>`; leave it draft
  if work remains. Do not merge - merging needs an explicit operator
  instruction.
- Add a comment summarizing the rebase and the reconciliation decisions when it
  helps reviewers:

  ```sh
  gh pr comment <n> --body-file /tmp/pr-comment.md
  ```

Verify the result:

```sh
gh pr view <n> --json title,state,isDraft,headRefOid,mergeable,mergeStateStatus,closingIssuesReferences
gh pr checks <n>
```

Confirm `headRefOid` matches local `HEAD`, the closing issue is linked, and CI
is green or running.

## Output

End with:

```text
Synced: <branch>
  - onto: origin/main @ <sha>
  - replayed: <n> commit(s)
  - conflicts: <files resolved, or none>
  - verify: pnpm run check <result>
  - push: force-with-lease origin/<branch> | skipped
  - pr: #<n> <title> | ready|draft | closes #<m> | CI <state> | none

Decisions:
  - <each non-trivial reconciliation and any surfaced contradiction>

Remaining:
  - <merge, draft removal, manual CI, or none>
```
