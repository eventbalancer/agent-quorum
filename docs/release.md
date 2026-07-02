# Release Process

This document is the release runbook for `agent-quorum`. It describes the full
cycle across git, GitHub Actions, GitHub Releases, and npm so every published
version is reproducible and traceable.

## Release Surfaces

One release version must line up across all surfaces:

- `package.json` version: the npm package version and the source of truth for
  the release number.
- Git tag: `vX.Y.Z`, pointing at the release commit on `main`.
- npm package: `agent-quorum@X.Y.Z`.
- GitHub Release: created from the same `vX.Y.Z` tag after npm publishing
  succeeds.

The `release` GitHub Actions workflow has two paths:

- Manual `workflow_dispatch`: validate only (`pnpm run check`,
  `pnpm run test:coverage`, build, `npm publish --dry-run --access public`). It
  never receives an npm token.
- Tag push `v*`: validate first, then run the `publish` job behind the protected
  `npm-publish` environment. A tag push alone does not publish; the environment
  approval is the final gate before `npm publish --access public`.

## Preconditions

Before starting a release:

1. Work from `main`.
2. The working tree must be clean.
3. Local `main` must match `origin/main`.
4. The current CI run for `main` must be green.
5. You must have permission to push tags and approve the `npm-publish`
   environment.
6. The npm `NPM_TOKEN` secret must be valid in GitHub Actions.

Useful checks:

```bash
git switch main
git fetch origin --tags
git status --short --branch
git log --oneline --decorate -5
npm view agent-quorum version
```

If local `main` is not exactly synced with `origin/main`, resolve that before
continuing. Never create a release tag from a dirty tree or an unpushed commit.

## Version Bump

Choose the next SemVer version:

- `patch`: bug fixes, documentation-only package updates, internal
  compatibility work.
- `minor`: new backwards-compatible CLI/API behavior.
- `major`: breaking CLI/API, artifact, config, or package contract changes.

Update `package.json` without creating a tag yet:

```bash
pnpm version patch --no-git-tag-version
# or: pnpm version minor --no-git-tag-version
# or: pnpm version major --no-git-tag-version
# or: pnpm version X.Y.Z --no-git-tag-version
```

If the lockfile changes, keep the lockfile change in the release commit. If it
does not change, do not touch it.

## Local Validation

Run the same core validation the package uses in CI:

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run test:coverage
pnpm run build
npm publish --dry-run --access public
```

The dry run verifies the package contents generated from `files`, `main`,
`types`, `exports`, and `bin` in `package.json`. Inspect the dry-run file list
before committing if the release changes package contents.

## Release Commit

Commit only the version bump and any release notes/docs intentionally tied to
the release:

```bash
git status --short
git add package.json pnpm-lock.yaml
git commit -m "chore(release): vX.Y.Z"
```

Omit `pnpm-lock.yaml` from `git add` when it did not change.

Push `main` and wait for CI to pass on GitHub:

```bash
git push origin main
```

Do not create the tag until the pushed release commit is green on `main`.

## Optional Workflow Dry Run

Use the manual release workflow when you want the GitHub runner to validate the
publish package before creating a tag:

1. Open GitHub Actions → `release`.
2. Run workflow from `main`.
3. Confirm the `validate` job passes.

This path does not publish and does not require npm approval.

## Tag Creation

Create the tag only after the release commit on `main` is green:

```bash
git tag -a vX.Y.Z -m "vX.Y.Z"
git push origin vX.Y.Z
```

The pushed tag starts the `release` workflow. The tag must point at the exact
release commit already present on `origin/main`.

Never move a release tag after npm publish succeeds. If a tag was pushed before
publishing and the validate job fails, delete the bad tag locally and remotely,
fix `main`, and create a fresh tag:

```bash
git tag -d vX.Y.Z
git push origin :refs/tags/vX.Y.Z
```

Only do this before the package is published to npm.

## npm Publish

Publishing is performed by GitHub Actions, not from a local machine.

After pushing `vX.Y.Z`:

1. Open the tag-triggered `release` workflow run.
2. Wait for the `validate` job to pass.
3. Review the workflow summary and dry-run package output.
4. Approve the `publish` job in the protected `npm-publish` environment.
5. Wait for `npm publish --access public` to complete.

After publish succeeds, verify npm:

```bash
npm view agent-quorum@X.Y.Z version
npm view agent-quorum@X.Y.Z dist.tarball
```

If publish fails after the tag exists but before npm accepts the version, fix
the issue on `main`, move/delete the unpublished tag as described above, and
rerun the release with a clean tag. If npm accepts the version, that version is
immutable; fix forward with a new version.

## GitHub Release

Create the GitHub Release after npm publishing succeeds. Its description must
be based on the commits that entered the release, not just the auto-generated
GitHub notes.

Before creating the tag, identify the previous release tag and inspect the
release range:

```bash
git describe --tags --abbrev=0 --match 'v[0-9]*' HEAD^
git log --reverse --date=short --format='%h%x09%ad%x09%s%d%n%b' <previous-tag>..HEAD
git diff --stat <previous-tag>..HEAD
```

If there is no previous release tag, use the full reachable history and call it
an initial release. Every non-release commit in the range should be represented
either as a specific bullet or inside a grouped section, including
documentation, tests, skills, and package-maintenance work when present.

1. Open GitHub Releases → Draft a new release.
2. Select the existing tag `vX.Y.Z`.
3. Title the release `vX.Y.Z`.
4. Write a structured description with:

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

5. Mention the comparison range (`<previous-tag>..vX.Y.Z`) and notable issue or
   PR references found in commit bodies. Use generated notes only as a
   cross-check.
6. Publish the GitHub Release.

Creating the GitHub Release after npm publish avoids advertising a release whose
package is not yet available.

## Post-Release Verification

After GitHub Release publication:

```bash
git fetch origin --tags
git rev-parse vX.Y.Z
git rev-parse origin/main
npm view agent-quorum@X.Y.Z version
npm pack agent-quorum@X.Y.Z --dry-run
```

Confirm:

- `vX.Y.Z` points at the release commit on `origin/main`.
- npm reports exactly `X.Y.Z`.
- GitHub Actions `release` is green.
- GitHub Release `vX.Y.Z` exists and links conceptually to
  `agent-quorum@X.Y.Z`.

## Failure Rules

- If validation fails before tag creation: fix `main`, rerun checks, then tag.
- If tag validation fails before npm publish: delete the unpublished tag, fix
  `main`, recreate the tag.
- If npm publish succeeds but GitHub Release creation fails: keep the tag and
  npm package; create or fix the GitHub Release manually.
- If npm publish succeeds with a bad package: never overwrite the version. Ship
  a new patch version.
- Do not use force push during the release process unless intentionally fixing
  unpublished pre-release history before a tag is created.
