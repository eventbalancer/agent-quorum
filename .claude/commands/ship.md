---
name: ship
description: Deliver agent-quorum changes through the repository's git, verification, and release boundaries. Use when the operator asks to run /ship, ship dirty changes, prepare or execute a commit and push, or release/publish agent-quorum to npm.
---

# ship

Deliver changes for this single `agent-quorum` checkout. This is a direct
repository delivery workflow: use git, pnpm, GitHub Actions, and npm directly;
never invent package, infra, Docker, migration, or pin-rewrite reconciliation.

One skill, two flows:

- **Change-set flow**: verify, commit, and optionally push dirty changes in
  this repository, then mark the session worktree done after a successful push.
- **Release flow**: follow `docs/release.md` for version bump, release commit,
  tag, GitHub Actions publish approval, npm verification, and GitHub Release.

Follow `AGENTS.md` and `docs/development/conventions.md`. For releases, read
`docs/release.md` before acting. A plain `/ship` request is delivery intent, but
still show the exact irreversible plan before staging, committing, pushing,
tagging, deleting tags, or triggering publish-related workflows.

## Arguments

```text
/ship
/ship <path> [<path>...]
/ship --dry-run [<path>...]
/ship --no-push [<path>...]
/ship --no-done [<path>...]
/ship --worktree <branch|path>
/ship --release patch|minor|major|X.Y.Z
/ship --release vX.Y.Z
/ship --release --dry-run patch|minor|major|X.Y.Z
```

`--simple` is an alias for the change-set flow. `--complex` has no direct
`agent-quorum` equivalent; route it to release flow only when release, version,
tag, or publish intent is also present. Otherwise stop and explain that this
repository has no reconciler.

Unknown flags are not passed through to another tool. Stop, explain the
accepted arguments, and ask for the intended operation.

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

## Step 0 - Preflight and route

1. Apply the worktree selection gate first: resolve, enter, and verify the target
   worktree (a silent no-op in a single-worktree checkout), then run every command
   below inside it. Resolve and verify the checkout:

   ```sh
   git rev-parse --show-toplevel
   git status --short --branch --untracked-files=all
   git branch --show-current
   ```

   Continue only in the `agent-quorum` checkout. If there are unrelated dirty
   files, keep them out of scope and name them in the plan. If the requested
   scope cannot be separated from unrelated dirt, stop and ask the operator.

2. Fetch remote refs before any push or release decision when `origin` exists:

   ```sh
   git remote get-url origin
   git fetch origin --tags
   git status --short --branch
   git rev-list --left-right --count HEAD...@{u}
   ```

   If the current branch is behind upstream, stop before shipping and ask
   whether to sync. Do not rebase, merge, or pull while dirty. If the branch has
   no upstream, ask for the push target before pushing.

3. Route the flow:

   - Use **release flow** when arguments contain `--release`, `release`,
     `publish`, `version`, `tag`, `vX.Y.Z`, or a bare semver bump
     (`patch`, `minor`, `major`) in a release context.
   - Use **change-set flow** otherwise.
   - In `--dry-run`, inspect and print the plan only.

4. Reject generated or unsafe scope unless the file is produced by the
   documented entry point for this flow:

   - never hand-edit or manually include `dist/`, `coverage/`, package-manager
     output, or lockfiles;
   - include `pnpm-lock.yaml` only when `pnpm install`, `pnpm version`, or an
     equivalent package-manager command changed it intentionally;
   - never include `.env`, secrets, local credentials, or editor/system noise.

## Change-set flow

Use this for normal implementation, docs, tests, config, scripts, and
repository-local skill changes that do not publish a new npm version.

1. Inspect every scoped change before planning a commit:

   ```sh
   git diff --stat -- <scope>
   git diff -- <scope>
   git diff --cached --stat -- <scope>
   git diff --cached -- <scope>
   git ls-files --others --exclude-standard -- <scope>
   ```

   Read untracked text files before including them. For binary files, report
   type and origin instead of guessing.

2. Classify the blast radius:

   - **Docs/agent-skill text only**: Markdown, `.agents/skills/`, `.claude/commands/`.
   - **Code/config/scripts/tests**: `src/`, `tests/`, `scripts/`, configs,
     package metadata, CI.
   - **Public or runtime contract**: `src/index.ts`, `package.json` exports,
     `agent-quorum` bin, CLI flags, config keys, `agent-quorum.json`,
     `skills/**/*.schema.json`, role prompts in `skills/`, or artifact shape.

3. Reconcile documentation before verification when public names, paths, flags,
   config keys, schema fields, role-skill contracts, package contents, or
   observable behavior changed. Relevant docs include `README.md`, `docs/`,
   `AGENTS.md`, `CLAUDE.md`, `.agents/skills/`, and `skills/`.

4. Verify with the narrowest command that proves the scoped change:

   Before verification, discover the originating GitHub issue, if any, using
   the same source order later used for the commit message: execution journal,
   source requirements document, current branch name, then the operator. When an
   originating issue is associated with the change set and is still open, ensure
   its project-board item is `In Progress` before verification, staging, or
   commit if no earlier skill already did so. Use GitHub through `gh`: discover
   the repository's linked ProjectV2 board with `gh api graphql`, add the issue
   item if it is absent, resolve the `Status` single-select field and the
   `In Progress` option with `gh project field-list`, then set the item with
   `gh project item-edit`. If several linked projects exist, ask the operator
   which board to use before continuing. If `gh`, the linked board, `Status`, or
   `In Progress` is unavailable, stop and report the blocker instead of
   continuing to ship an issue-linked change without the board transition.

   - docs or repository-local skills only:

     ```sh
     pnpm run format-check
     ```

   - code, config, scripts, tests, CLI/API, package metadata, provider/runtime,
     role prompts, or schemas:

     ```sh
     pnpm run check
     ```

   - package contents, public API, or release-adjacent changes: run
     `pnpm run build` after `pnpm run check`; smoke-test the built public
     package when the API surface changed.

   If verification cannot be run, stop before commit/push unless the operator
   explicitly accepts the residual risk.

5. Verify command mirrors when `.agents/skills/` or `.claude/commands/`
   changed:

   ```sh
   cmp -s .claude/commands/requirements.md .agents/skills/requirements/SKILL.md
   cmp -s .claude/commands/issues.md .agents/skills/issues/SKILL.md
   cmp -s .claude/commands/solution-handoff.md .agents/skills/solution-handoff/SKILL.md
   cmp -s .claude/commands/prompt-architect.md .agents/skills/prompt-architect/SKILL.md
   cmp -s .claude/commands/execute.md .agents/skills/execute/SKILL.md
   cmp -s .claude/commands/tidy.md .agents/skills/tidy/SKILL.md
   cmp -s .claude/commands/ship.md .agents/skills/ship/SKILL.md
   ```

6. Generate one conventional commit message for the scoped change:

   - type: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`,
     or `build`;
   - optional scope when it improves clarity;
   - subject lowercase, imperative, at most 72 characters, no trailing period;
   - subject and body use plain ASCII printable characters only: no emoji and no
     decorative Unicode (em or en dashes, smart quotes, arrows, box drawing);
     write a plain hyphen `-` instead of `—`. Keep the body concise and factual;
   - no `Co-Authored-By` lines.

   Link the originating GitHub issue. Use the issue discovered before
   verification when available; otherwise discover it, in order, from: the
   execution journal under `.agents/execution-journals/` (the `Issue` field),
   the source requirements document `Issue:` header, the current branch name, or
   the operator. When an originating issue is found, the commit body must
   include `Closes #<n>` when this change fully resolves it, or `Refs #<n>` when
   it touches the issue without resolving it; do not commit without one of them.
   When it is unclear whether the change closes the issue, ask the operator
   before committing. Omit the line only when no issue is associated.

7. Present the irreversible plan before executing:

   ```text
   FLOW        change-set
   BRANCH      <current branch> -> <upstream or requested push target>
   FILES       <exact scoped files>
   VERIFY      <commands run and result>
   COMMIT      <header>
   ISSUE       Closes #<n> | Refs #<n> | none
   PUSH        yes|no
   EXCLUDED    <dirty files intentionally left out>
   RISKS       <unrun checks or unusual state>
   ```

   In `--dry-run`, stop here. Otherwise ask for confirmation unless the
   operator already supplied an exact commit/push instruction in the same turn.

8. After approval, stage exact paths only:

   ```sh
   git add -- <file> [<file>...]
   git status --short
   git commit -m "<header>" [-m "<body>"]
   ```

   Use `git add -p` only when the operator asks for partial staging. Never use
   `git add .` for this command.

9. Push only when requested or when the approved plan says `PUSH yes`:

   ```sh
   git push origin <branch>
   ```

   If push is skipped, report the local commit hash and the exact push command
   the operator can approve later.

10. Mark the session worktree done after a successful push. When the change-set
    flow ran inside a session worktree (the current branch matches `session/*`)
    and the branch was pushed, flag the session complete so the selection gate
    stops offering it by default:

    ```sh
    pnpm run worktree:done "$(git branch --show-current)"
    ```

    This is a soft marker: it does not require integration into `main` and only
    reports that status. Skip it when `--no-done` is passed, when push was
    skipped (`--no-push` or `PUSH no`), in `--dry-run`, or when shipping from the
    primary checkout. The worktree stays on disk and inspectable; reopen later
    with `pnpm run worktree:reopen <branch>`, and remove it with
    `pnpm run worktree:release <branch>` once it is merged into `main`.

## Release flow

Use this only when the operator intends to publish a new npm version or create a
release tag. `docs/release.md` is the source of truth; if this section and that
runbook conflict, follow the runbook and report the mismatch.

1. Read `docs/release.md` in full. Confirm the release surfaces:
   `package.json` version, git tag `vX.Y.Z`, npm package
   `agent-quorum@X.Y.Z`, and GitHub Release `vX.Y.Z`.

2. Enforce preconditions before changing files:

   ```sh
   git status --short --branch
   git branch --show-current
   git fetch origin --tags
   git rev-parse HEAD
   git rev-parse origin/main
   npm view agent-quorum version
   ```

   Release starts from a clean `main` that matches `origin/main`. If not on
   `main`, ask before switching. If dirty, stop and ship or discard the dirty
   work separately. If local and remote differ, stop and ask how to sync.

   When `gh` is available, check the current `main` CI state:

   ```sh
   gh run list --workflow ci --branch main --limit 5
   ```

   If CI is not verifiably green, stop or ask whether to continue with the
   explicit risk recorded.

3. Choose the version from arguments or ask the operator. Compare it with the
   current `package.json` and `npm view agent-quorum version`. Do not reuse a
   published npm version.

4. In `--dry-run`, print the release plan and stop before `pnpm version`.

5. Apply the version bump with the package manager:

   ```sh
   pnpm version patch --no-git-tag-version
   # or minor, major, or X.Y.Z
   ```

   If `pnpm-lock.yaml` changes, keep it in the release commit. If it does not
   change, do not add it.

6. Run the local validation from the runbook:

   ```sh
   pnpm install --frozen-lockfile
   pnpm run check
   pnpm run build
   npm publish --dry-run --access public
   ```

   Inspect and summarize the dry-run package file list before committing.

7. Present the release commit plan:

   ```text
   FLOW        release
   VERSION     X.Y.Z
   BRANCH      main -> origin/main
   FILES       package.json [pnpm-lock.yaml if changed]
   VERIFY      install, check, build, publish dry-run
   COMMIT      chore(release): vX.Y.Z
   PUSH MAIN   yes
   TAG         vX.Y.Z after main CI is green
   PUBLISH     GitHub Actions protected npm-publish approval, not local npm publish
   ```

   Ask for confirmation before staging and committing.

8. After approval, commit and push the release commit:

   ```sh
   git add package.json pnpm-lock.yaml
   git commit -m "chore(release): vX.Y.Z"
   git push origin main
   ```

   Omit `pnpm-lock.yaml` from `git add` when it did not change.

9. Wait for CI on `origin/main` to pass. Use `gh run list` / `gh run view` when
   available, or ask the operator to confirm the GitHub UI state. Do not create
   the release tag while main CI is unknown or failing unless the operator
   explicitly accepts the risk.

10. Build the GitHub Release description from the commits that entered the
    release. Determine the previous release tag before creating the new tag:

    ```sh
    git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD^
    git log --reverse --date=short --format='%h%x09%ad%x09%s%d%n%b' <previous-tag>..HEAD
    git diff --stat <previous-tag>..HEAD
    ```

    If there is no previous release tag, use the full reachable history and
    call it an initial release. Include every non-release commit from the range,
    either as an individual bullet or in a grouped section, so no behavior,
    documentation, test, skill, or packaging change disappears. Treat the
    GitHub auto-generated notes as a cross-check only, not as the final text.

    Draft release notes with this structure:

    ```text
    ## Summary
    - <1-3 bullets describing the release outcome>

    ## Changes
    - <grouped, specific bullets based on the commit range>

    ## Verification
    - <local checks, CI state, npm publish state>

    ## Package
    npm: agent-quorum@X.Y.Z
    ```

    Mention the comparison range (`<previous-tag>..vX.Y.Z`) and any notable
    issue or PR references found in commit bodies. Keep the text factual and
    user-facing; do not paste raw commit logs as the description.

11. After main CI is green and the operator approves the tag step:

    ```sh
    git tag -a vX.Y.Z -m "vX.Y.Z"
    git push origin vX.Y.Z
    ```

12. Publishing is performed by GitHub Actions, not locally. After the tag push,
    tell the operator to open the tag-triggered `release` workflow, review the
    validation summary and dry-run package output, approve the protected
    `npm-publish` environment, and wait for `npm publish --access public`.

13. Verify the published package and GitHub Release:

    ```sh
    npm view agent-quorum@X.Y.Z version
    npm view agent-quorum@X.Y.Z dist.tarball
    npm pack agent-quorum@X.Y.Z --dry-run
    git fetch origin --tags
    git rev-parse vX.Y.Z
    git rev-parse origin/main
    ```

    The GitHub Release is created after npm publishing succeeds. Use the drafted
    release description from the commit range, with `npm: agent-quorum@X.Y.Z` in
    the `Package` section. If `gh` is available and the operator approves
    creating the release from the CLI, use:

    ```sh
    gh release create vX.Y.Z --title "vX.Y.Z" --notes-file <notes-file>
    ```

14. Failure handling follows `docs/release.md`. Never move or delete a release
    tag after npm publish succeeds. Delete a bad unpublished tag only after the
    operator explicitly asks and confirms the package was not published.

## Output

End with:

```text
Shipped: agent-quorum
  - flow: change-set|release
  - commit: <sha or none>
  - push: <remote/branch or skipped>
  - tag: <tag or none>
  - worktree: marked done <branch> | active (--no-done|push skipped|primary checkout) | n/a

Verified:
  - <command>: <result>

Remaining:
  - <manual CI, npm-publish approval, GitHub Release, or none>
```

If the workspace is clean, say so and do not create an empty commit.
