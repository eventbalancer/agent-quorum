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
  this repository.
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

## Step 0 - Preflight and route

1. Resolve and verify the checkout:

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
   cmp -s .claude/commands/solution-handoff.md .agents/skills/solution-handoff/SKILL.md
   cmp -s .claude/commands/prompt-architect.md .agents/skills/prompt-architect/SKILL.md
   cmp -s .claude/commands/execute.md .agents/skills/execute/SKILL.md
   cmp -s .claude/commands/ship.md .agents/skills/ship/SKILL.md
   ```

6. Generate one conventional commit message for the scoped change:

   - type: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`,
     or `build`;
   - optional scope when it improves clarity;
   - subject lowercase, imperative, at most 72 characters, no trailing period;
   - include `Closes #<n>` in the body only when the change resolves an issue;
     use `Refs #<n>` for related work;
   - no `Co-Authored-By` lines.

7. Present the irreversible plan before executing:

   ```text
   FLOW        change-set
   BRANCH      <current branch> -> <upstream or requested push target>
   FILES       <exact scoped files>
   VERIFY      <commands run and result>
   COMMIT      <header>
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

10. After main CI is green and the operator approves the tag step:

    ```sh
    git tag -a vX.Y.Z -m "vX.Y.Z"
    git push origin vX.Y.Z
    ```

11. Publishing is performed by GitHub Actions, not locally. After the tag push,
    tell the operator to open the tag-triggered `release` workflow, review the
    validation summary and dry-run package output, approve the protected
    `npm-publish` environment, and wait for `npm publish --access public`.

12. Verify the published package and GitHub Release:

    ```sh
    npm view agent-quorum@X.Y.Z version
    npm view agent-quorum@X.Y.Z dist.tarball
    npm pack agent-quorum@X.Y.Z --dry-run
    git fetch origin --tags
    git rev-parse vX.Y.Z
    git rev-parse origin/main
    ```

    The GitHub Release is created after npm publishing succeeds. Include
    `npm: agent-quorum@X.Y.Z` in the release notes.

13. Failure handling follows `docs/release.md`. Never move or delete a release
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

Verified:
  - <command>: <result>

Remaining:
  - <manual CI, npm-publish approval, GitHub Release, or none>
```

If the workspace is clean, say so and do not create an empty commit.
