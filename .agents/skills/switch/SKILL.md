---
name: switch
description: Switch the session's execution context between the primary checkout (root) and a session worktree - resolve the target, surface done and active-edit state, enter it, and verify the handoff. Use when the operator asks to run /switch, to enter or work in a specific worktree, to return to the root repo or primary checkout, or asks where the session is currently working.
---

# switch

Move this session's execution context to the primary checkout (`root`) or to a
linked session worktree, on operator request, deliberately and verifiably. The
resolver is `pnpm run worktree:switch`; the move itself is the host
`EnterWorktree` / `ExitWorktree` tool or `cd`; the proof is
`git rev-parse --show-toplevel`.

Follow `AGENTS.md` and `docs/development/conventions.md`. Switching only
changes where subsequent commands run; it never integrates, rebases, or edits
work by itself.

## Boundaries

- Read-only toward every non-target worktree: inspect candidates with
  `git -C <path> ...` during discovery, never mutate them.
- The only mutation this skill performs is the active-edit marker refresh that
  `worktree:switch` applies to a live session worktree target.
- Never create, remove, reopen, or release a worktree here; that is
  `worktree:create` / `worktree:reopen` / `worktree:release` / `/ship`.
- The primary checkout is a dispatch context: after `/switch root`, keep edits
  trivial per conventions unless the operator explicitly asks for work on
  `main`.
- Report resolved absolute paths to the operator.

## Arguments

```text
/switch                     # report the current context, then offer targets
/switch root                # primary checkout
/switch <slug|branch|path>  # a worktree, resolved like other worktree subcommands
```

Unknown flags are not passed through: stop, list the accepted arguments, and
ask.

## Step 0 - Current context

```sh
pnpm run worktree:switch
```

Report the current path and kind. When the operator only asked where the
session is working, stop here.

With no target argument, enumerate targets with `pnpm run worktree:list` and
present a menu (host `AskUserQuestion` when available, else a numbered list):
`root` plus every non-done session worktree, each with its branch and path
verbatim, its task description or `(no task description recorded)`, and its
edit status. Include done worktrees only on explicit operator request,
mirroring `docs/development/worktree-selection-gate.md`.

## Step 1 - Resolve the target

```sh
pnpm run worktree:switch <root|slug|branch|path>
```

The subcommand resolves the target, prints from/to, branch, and kind plus, for
a worktree, its task and pre-switch edit status, refreshes a live session
worktree's active-edit marker, and prints the handoff instructions. The `root`
keyword takes precedence over slug matching; reach a hypothetical
`session/root` worktree by full branch name or path. Stop on a resolver error
(zero or multiple matches) and ask rather than guessing.

## Step 2 - Safety gate

- Status `active (marker refreshed ...)` that this session did not write means
  another session may be editing there: confirm with the operator before
  entering (the confirmation rule of the worktree selection gate).
- `note: marked done`: entering to inspect is fine; before any edit, offer
  `pnpm run worktree:reopen <branch>`.
- A dirty target tree is reported, not blocked; do not clean it up.

## Step 3 - Enter and verify

- Enter with the host tool: `EnterWorktree <path>` for a worktree, or
  `ExitWorktree` to return to root when the session entered through
  `EnterWorktree`. Fall back to `cd <path>`.
- Verify the handoff: `git rev-parse --show-toplevel` must print the target
  path. Stop if it does not; acting could mutate the wrong tree.
- From then on run every command inside the new context; reserve
  `git -C <path>` for read-only peeks at other trees.

## Output

```text
Switched: <from-path> -> <to-path>
  - branch: <branch> | (detached)
  - kind: root (primary checkout) | session worktree | linked worktree
  - marker: refreshed | n/a
  - notes: <done/reopen hint, active-edit confirmation, or none>
```

When no switch happened - already in the target context, or the operator only
asked for the current context - report that instead.
