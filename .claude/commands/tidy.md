---
name: tidy
description: Refactor the current agent-quorum dirty change set before commit without changing behavior. Use when the operator asks to tidy, clean up, refactor dirty files, polish recent implementation, or run a pre-commit cleanup on modified/untracked files or listed paths.
---

# Tidy

Refactor only the current dirty change set so it is easier to read, better
structured, and aligned with `agent-quorum` conventions. Run this after a
feature or fix is implemented and before any commit.

Follow `AGENTS.md` and `docs/development/conventions.md`. The original Claude
slash-command form accepted `/tidy`; in Codex, parse the user's prompt after
`$tidy` as the same optional scope.

## Arguments

```text
Use $tidy
Use $tidy for <path> [<path>...]
Use $tidy in <repo-or-subdir>
Use $tidy --worktree <branch|path>
```

Empty scope means every dirty file in the current `agent-quorum` checkout. Path
scope means only the listed dirty files. Reject clean files, files outside the
checkout, generated artifacts, lockfiles, and unrelated cleanup unless the file
is a documented mirror counterpart or a new helper extracted from an already
dirty file.

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

1. **Identify scope.** First resolve and enter the target worktree with the
   worktree selection gate above (a silent no-op in a single-worktree checkout),
   then operate inside it. Use read-only history commands:

   ```bash
   git status --porcelain=v1 --untracked-files=all
   git diff --stat
   git diff --name-only --diff-filter=ACMRTUXB
   git ls-files --others --exclude-standard
   ```

   Reconcile tracked and untracked paths before editing. If a path argument is
   supplied, verify that each path is dirty with `git status --short -- <path>`.
   Work only inside the resolved dirty set plus any documented mirror
   counterpart found in the mirror gate.

2. **Read each scoped file end-to-end.** Diffs are not enough; local smells are
   visible only in file context. Read related tests, docs, and callers as needed
   before editing.

3. **Apply the quality criteria below.** Prefer the smallest local refactor that
   improves readability without changing behavior. If a refactor requires files
   outside the dirty set, new dependencies, public API changes, schema changes,
   or design decisions, stop and surface it as separate work.

4. **Mirror repository-local skill commands.** When the dirty set contains
   `.agents/skills/<name>/SKILL.md` or `.claude/commands/<name>.md`, reconcile
   the documented mirror pairs from `docs/development/agent-skill-flow.md`.
   Read both sides, decide which side is the source of truth from the scoped
   change, copy it byte-for-byte to the counterpart, include the counterpart in
   the tidy scope, and verify with `cmp -s`. If both sides changed and conflict,
   stop and ask instead of merging by hand. Do not invent a mirror for a skill
   or command with no documented counterpart; surface that as separate work.

5. **Reconcile related documentation.** This is mandatory when names, paths,
   flags, config keys, public API, schema contracts, or observable behavior
   changed. Follow the documentation reconciliation gate below.

6. **Verify.** Run the narrowest checks that prove the tidy did not change
   behavior. For code changes, `pnpm run check` is the finished-state bar unless
   there is a clear reason to report a narrower check and its residual risk.

7. **Report.** End with the checklist in the Output section. Do not stage,
   commit, push, create branches, or open PRs.

## Quality Criteria

Apply these in order until no issue remains in the scoped files.

### Readability

- Use braced, multi-line bodies for every control-flow body and function or
  method body, even for one statement.
- Keep concise arrow bodies only for short pure mappers/selectors. Use braces
  and explicit `return` for side effects, multi-step callbacks, nested logic,
  exported behavior, or non-trivial returned object literals.
- Extract object parameter and return shapes when they are exported, reused,
  have three or more fields, contain nested/non-primitive fields, or return two
  or more fields. In this repo, use `interface` for object shapes and `type`
  for unions, tuples, mapped/conditional types, and function aliases.
- Extract non-trivial discriminated-union variants into named object shapes
  near the union, then make the union a simple list of variants. Skip the
  standard two-member result pattern and tiny discriminator-only unions.
- Prefer guard clauses and keep nesting around three levels or less.
- Name booleans positively with `is`, `has`, `can`, `should`, `did`, or `will`.
- Move meaningful literals to named constants. Inline only local self-evident
  values such as `0`, `1`, and `''`.
- Extract named helpers or named booleans when a block needs a comment to say
  what it does, an `if` joins three or more predicates, or business logic is
  hidden inside anonymous `.reduce` / `.filter` chains.
- Keep sibling branches and switch cases symmetrical.
- Keep one level of abstraction per function.

### TypeScript Quality

- Do not introduce `any`. Use `unknown` plus narrowing, precise types, or
  generics.
- Close discriminated-union switches with an exhaustive `satisfies never` path.
- Use `readonly` by default for fields and array parameters unless mutation is
  real.
- Prefer `undefined` for domain absence; normalize external `null` at the
  boundary.
- Throw stable typed errors. Use `HaltError` for operator-facing fatal exits.
  Catch as `unknown`, narrow with `instanceof`, and never branch on
  `err.message`.
- Use named exports and preserve `src/index.ts`, `package.json` exports, and
  the `agent-quorum` bin unless an explicit breaking change was requested.
- Use `const`, `===`, ESM imports with `.js` relative extensions, and no
  `export default` in touched files.
- Keep time, randomness, process I/O, and global reads at boundaries. Inject a
  clock when pure logic depends on the current time.
- Delete dead code, stale comments, commented-out code, and helpers that drop to
  zero callers. Inline helpers that drop to one caller unless the name carries
  meaningful abstraction.

### Architecture

- Respect the layer direction `cli -> core -> providers -> runtime`; lower
  layers do not import higher layers.
- Provider calls go through `providerRun`. `core/` and `cli/` do not spawn
  provider CLIs directly.
- Keep pure orchestration/domain logic in `src/core/`, provider quirks in
  `src/providers/`, and low-level technical primitives in `src/runtime/`.
- A helper used by one pass lives beside that pass. Promote shared modules only
  when a second real consumer appears.
- Treat `skills/` role prompts and `*.schema.json` files as runtime contracts;
  changing them requires matching tests or docs.
- Do not hand-edit `dist/`, `coverage/`, lockfiles, package-manager output, or
  other generated artifacts.

## Documentation Reconciliation Gate

Do not report success until this gate is complete.

1. **Build the search corpus.** From the diff, list every changed public or
   documented term: renamed/removed/relocated functions, types, constants,
   exported symbols, file paths, directory paths, CLI commands, flags, config
   keys, environment variables, schema fields, role-skill contracts, ports,
   artifact names, and changed observable behavior. If the corpus is empty,
   report that explicitly.

2. **Search one term at a time.** Search repository docs and agent-facing
   prompts with a safe `rg --files | xargs rg` pattern. Record the exact command
   for every term.

   ```bash
   rg --files --hidden --no-ignore-vcs \
     -g '*.md' -g '*.json' -g '*.toml' \
     -g '!**/node_modules/**' -g '!dist/**' -g '!coverage/**' \
     | xargs rg -n --fixed-strings -- '<term>'
   ```

   If a term contains shell metacharacters, quote it safely before running the
   command. A term with zero hits is acceptable; an unsearched term is not.
   Never start long-running searches detached or with zero wait. Kill any search
   shell that exceeds about 30 seconds before continuing.

3. **Triage every hit.** For each match, update the documentation or record why
   it is unaffected. Relevant locations include `README.md`, `docs/`,
   `AGENTS.md`, `CLAUDE.md`, `.agents/skills/`, `.claude/commands/`, `skills/`,
   `config.example.json`, and schema files. Do not add new documentation just to
   document the tidy; only keep existing docs accurate.

4. **Gate completion.** If the corpus is non-empty and any term was not searched
   or any hit was left untriaged, the tidy is incomplete.

## Verification

- For routine TypeScript refactors, run `pnpm run typecheck` and
  `pnpm run lint` at minimum.
- Before claiming a behavior-affecting or implementation task is done, run
  `pnpm run check`.
- If public API, CLI, config, schemas, or role skills are touched, include the
  relevant docs/tests and use `pnpm run check` as the floor.
- If the tidy touches only markdown or agent skill text, run the relevant
  validator or `pnpm run format-check` when practical, and report any check not
  run.
- If `.agents/skills/` or `.claude/commands/` changed, run `cmp -s` for every
  documented mirror pair affected by the scoped change, and report the pairs
  checked.
- If a test fails after a pure refactor, assume behavior changed. Revert or
  rethink the refactor rather than weakening tests.

## Boundaries

- Do not change behavior, fix unrelated bugs, or broaden scope.
- Do not edit files outside the dirty set except for a helper extracted from a
  dirty file, a counterpart required by the mirror gate, or documentation
  required by the reconciliation gate.
- Do not touch secrets, `.env` files, lockfiles, generated output, or migration
  files.
- Do not stage, commit, push, create branches, or open PRs.
- Ask before a code refactor would cross repository boundaries, require new
  dependencies, alter public contracts, or introduce a new architecture concept.

## Output

End with this checklist:

```text
Tidied: agent-quorum (<n> files)
  - path/to/file.ts - extracted X helper, inlined Y, dropped dead Z

Docs reconciled:
  - <term> -> `<exact search command>` -> updated docs/path.md
  - <term> -> `<exact search command>` -> no references found
  - <term> -> `<exact search command>` -> unaffected because <reason>
  - no symbols/paths/flags/behaviors changed

Mirrors reconciled:
  - .claude/commands/<name>.md <-> .agents/skills/<name>/SKILL.md -> copied <source> to <target>; `cmp -s ...` passed
  - no mirrored skill or command changes

Verified:
  ✓ pnpm run check
  ✓ <narrower command, if justified>

Surfaced for separate work:
  - <file>: <issue> (out of change-set scope)
```
