---
name: execute
description: Execute an existing agent-quorum implementation plan with a lightweight deviation journal. Use when the operator asks to run /execute, execute a saved plan file, implement an approved plan path, or follow a plan while recording only deviations, blockers, and verification issues.
---

# execute

Execute an existing plan for this single `agent-quorum` checkout. The plan is
the implementation spec; this workflow is not for designing a new plan. Keep a
lightweight journal that records only deviations and issues. Silence means the
step succeeded as planned.

Follow the repository-root `AGENTS.md` / `CLAUDE.md` operating rules and
`docs/development/conventions.md`. In Codex, parse the user's prompt after
`$execute` as the same plan argument accepted by the original Claude
slash-command form.

## Arguments

```text
/execute <plan-path>
/execute --worktree <branch|path> <plan-path>
Use $execute <plan-path>
Use $execute for <plan-path>
```

`<plan-path>` resolves through one entry point to either a single readable
markdown plan file or a `plan.package/` directory. Accept absolute paths,
`~/...`, and paths relative to the repository root.

- A single `.md` plan file keeps today's single-plan behavior described below.
- A `plan.package/` directory (detected by `README.md` + `journal.md` +
  at least one `phase-*.md`) is executed through the package-aware workflow in
  the next section.
- If the argument names a plan run directory and exactly one implementation
  plan or one `plan.package/` is obvious, use it; otherwise stop and ask for the
  exact path.

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

## Package-Aware Execution

When `<plan-path>` is a `plan.package/` directory, the package is the execution
contract and `plan.package/run.md` is the protocol you follow. This is one
entry point, not a second skill: the bootstrap below replaces "read the plan
end to end" for packages, while single-file plans are unchanged.

1. **Bootstrap in order** (do not read the master `plan.md` end to end): read
   `README.md` (map, route, split rationale), then `journal.md` (progress table,
   current/next phase, stop log), then `run.md` (the protocol), then the current
   `phase-*.md` selected from the first pending journal progress row. Read a
   bounded section of `plan.md` only when a phase doc references it by name.
2. **Emit a positioning report before any edit.** State, as the package
   `run.md` Step 0 requires: the last completed unit; the selected next unit;
   the phase document path; the preflight / blocking-prerequisite state; whether
   an operator override was applied (and, if so, what automatic positioning
   would have selected and why the override wins); and the immediate intent.
3. **Honor an operator override** of the next unit over the journal-derived
   selection, but record the divergence in the positioning report and
   `journal.md`.
4. **Stop at phase boundaries for operator approval.** Execute exactly one
   pending phase pin, update `journal.md`, then stop unless the operator asked
   to continue.
5. **On contradiction** between journal state and workspace state — a missing or
   materially different file, route, schema, or interface; a repeated failure;
   cycling edits — stop and write the stop report from `plan.package/run.md`
   "Stop Report Format" into `journal.md`, then ask the operator.

The package execution journal is `plan.package/journal.md` (the in-package
progress record), not the repository `.agents/execution-journals/` journal used
for single-file plans.

## Journal Location

Store execution journals under the repository root:

```text
.agents/execution-journals/exec-<slug>-<YYYY-MM-DD>.md
```

Derive `<slug>` from the resolved plan path:

1. Prefer the path relative to the repository root when possible.
2. Strip the final `.md`.
3. Take the last three path segments.
4. Join them with `-`.
5. Normalize to lowercase ASCII: replace every non-alphanumeric run with `-`,
   trim leading and trailing `-`, and use `plan` if the result is empty.

The `.agents/execution-journals/` directory is generated workspace state and is
git-ignored except for `.gitkeep`.

## Workflow

### Step 0 - Bootstrap

1. Apply the worktree selection gate to choose the target worktree, but resolve
   and read `<plan-path>` against the invocation checkout (Step 0 item 2) before
   entering the selected worktree; then enter and verify it and run the
   implementation and journal inside it. The gate is a silent no-op in a
   single-worktree checkout. Stop if `<plan-path>` cannot be resolved or read
   against the invocation checkout. Resolve and verify the checkout:

   ```sh
   git rev-parse --show-toplevel
   git status --short --branch --untracked-files=all
   ```

   Continue only in the `agent-quorum` checkout. Preserve unrelated dirty files.
   If the requested plan cannot be executed without touching unrelated dirty
   work, stop and ask the operator.

2. Resolve the plan path. Expand `~` to `$HOME`, make relative paths
   repository-root relative, and verify the file exists, is readable, and is a
   markdown file.

3. Read the plan end-to-end before editing. Extract the title from the first
   `# ` heading; if no title exists, use the plan filename stem.

4. Determine the originating GitHub issue from the plan, its source prompt or
   requirements document (the `Issue:` header), or the operator. When an
   originating issue is known, move its project-board item to `In Progress`
   before preflight or code changes. Use GitHub through `gh`: discover the
   repository's linked ProjectV2 board with `gh api graphql`, add the issue item
   if it is absent, resolve the `Status` single-select field and the
   `In Progress` option with `gh project field-list`, then set the item with
   `gh project item-edit`. If several linked projects exist, ask the operator
   which board to use before continuing. If `gh`, the linked board, `Status`, or
   `In Progress` is unavailable, stop and report the blocker instead of
   continuing to work the issue without the board transition.

5. Create the journal file from the template before code changes. Do not
   overwrite an existing journal; append a numeric suffix before `.md` if the
   date and slug collide.

6. Read `AGENTS.md`, `CLAUDE.md` when present, and
   `docs/development/conventions.md` before editing. Read additional docs named
   by the plan, such as architecture, API, CLI, configuration, release, or skill
   flow docs.

7. Confirm the plan is implementation-ready. If it is a prompt, requirements
   draft, partial investigation, or ambiguous design note, stop and route it
   through `/prompt-architect` or `/requirements` instead of guessing.

### Step 1 - Preflight the Plan

For every concrete file, directory, symbol, CLI flag, config key, schema field,
role skill, API, script, and command the plan references:

1. Verify that it exists in the current checkout. Use `rg`, `rg --files`,
   TypeScript exports, package metadata, and docs as appropriate.
2. If the plan is stale but the intended target is obvious, adapt locally and
   log a terse deviation.
3. If the stale reference changes scope, public behavior, or the intended
   design, stop and ask the operator.
4. If the plan would edit generated artifacts (`dist/`, `coverage/`, lockfiles,
   package-manager output) or secrets, stop unless the plan explicitly names the
   documented generator command or safe secret handling path.

Preflight is part of execution. Journal only stale references, ambiguous gaps,
and decisions that changed from the plan.

### Step 2 - Execute the Plan

For each phase or step:

1. Implement only what the plan asks for. Keep changes scoped to existing
   ownership boundaries and repository conventions.
2. Read surrounding code before editing. For role skills or schemas under
   `skills/`, treat the I/O shape as a runtime contract and update matching
   tests or docs.
3. Use repository entry points: `pnpm run <script>` and `pnpm exec <bin>`. Do
   not use `npx`.
4. After each meaningful phase, run the narrowest relevant check:
   - markdown or repository-local skill text only: `pnpm run format-check` when
     practical;
   - routine TypeScript edits: `pnpm run typecheck`;
   - broad, public, schema, provider, CLI, or behavior changes:
     `pnpm run check`.
5. Journal only deviations, blockers, tool failures, pre-existing bugs surfaced
   by the work, or verification failures. Do not log clean steps, routine
   command output, reasoning, or details already visible in `git diff`.

### Step 3 - Verify

Choose verification by blast radius, then run it before claiming the work is
done:

- docs or repository-local skill text only: `pnpm run format-check`;
- routine code changes: `pnpm run typecheck` and `pnpm run lint` at minimum;
- behavior changes, public API, CLI flags, config, schemas, providers, runtime,
  role skills, or cross-module orchestration: `pnpm run check`;
- tests added or changed: include `pnpm run test` if a narrower command was
  used earlier;
- public package/API changes: run `pnpm run build` after `pnpm run check` and
  smoke-test the built package when relevant.

Log failures in the journal `Issues` section with the exact command and a terse
cause. If a check cannot be run, log why and report the residual risk.

### Step 4 - Finalize

1. Fill the journal `Summary` with one sentence.
2. Set `Status` to `done`, or `partial` if anything remains blocked.
3. Delete empty `Deviations` or `Issues` sections. A clean run should produce a
   near-empty journal.
4. Record the originating GitHub issue in the journal `Issue` field as
   `Closes #<n>` when this work fully resolves the issue, or `Refs #<n>` when it
   is partial, blocked, or related. Record `none` only when no issue is
   associated. This is what `/ship` reads to link the commit.
5. Do not stage, commit, push, create branches, or open PRs. The finished state
   is implemented changes, verification results, and the journal.

## Journal Template

```markdown
# Exec - <plan-title>

| Field  | Value                          |
| ------ | ------------------------------ |
| Plan   | `<filename>`                   |
| Date   | <YYYY-MM-DD>                   |
| Issue  | Closes #<n> / Refs #<n> / none |
| Status | in-progress                    |

---

## Deviations

## Issues

## Summary
```

## What to Log

Log one terse line per relevant item.

| Category             | Example                                                                                           |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| Plan gap             | Step 3.2 assumes `buildHash()` exists; current code uses `contentHash()`.                         |
| Side-effect breakage | Changing `RunContext` affected `src/core/summary.ts`, which the plan did not mention.             |
| Stale reference      | Plan references `src/core/pass.ts`; the behavior now lives in `src/core/loop.ts`.                 |
| Design decision      | Plan says "add retry" without count; chose the existing `retry` helper defaults.                  |
| Tooling issue        | `pnpm run typecheck` failed before edits on unrelated `tests/helpers/harness.ts` diagnostics.     |
| Pre-existing bug     | `validatePlanShape()` accepts empty reviewer output; unrelated to this plan, surfaced in testing. |
| Blocked step         | Phase 4 requires a GitHub token; skipped and flagged for manual completion.                       |

Do not log:

- steps that went as planned;
- routine build, lint, or test output;
- private reasoning or decision process;
- anything already visible from `git diff`;
- secrets, tokens, environment values, or credential material.

## Rules

- Plan is the spec. Do not add scope, refactor adjacent code, or improve
  unrelated behavior.
- Journal is for the reviewer. Keep it scannable in 30 seconds.
- Verify before claiming done. `pnpm run typecheck` is the floor for code
  changes; `pnpm run check` is the floor for broad or contract-touching changes.
- Do not commit. The operator decides when to `/ship`.
- Stop on blockers. Missing dependencies, broken upstream state, and ambiguous
  plan gaps require operator input.
- Respect repository sovereignty. This skill is for `agent-quorum`; if a plan
  touches another checkout, stop unless the operator explicitly asked for
  cross-repo execution and that repo's rules have been read.
- Leave no orphan background shells or detached long-running commands.

## Output

End with:

```text
Executed: agent-quorum (<done|partial|blocked>)
Plan: <absolute plan path>
Journal: <absolute journal path>
Changed:
  - <path> - <short summary>
Verified:
  - <command> - <result>
Issues:
  - <none or journaled blocker/failure>
```
