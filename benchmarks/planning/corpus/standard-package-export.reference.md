<!-- benchmark-reference-approval: operator-approval-required -->

# Public Final-Status Formatter

## Design

Create one pure inner-layer formatter and re-export it additively from the package
root. Existing CLI rendering delegates to it, so public and CLI text cannot drift.

## Implementation

1. Locate the current canonical one-line rendering and its callers. Extract it to
   a precisely named pure core module that depends only on `RunFinalStatus` and a
   reason string.
2. Preserve every current spacing, empty-reason, and status-label branch. Replace
   the CLI caller with the helper before exporting it.
3. Add a named export and type surface in `src/index.ts`. Do not change existing
   exports, `package.json` conditions, main/types entries, or the bin mapping.
4. Avoid importing CLI code from the public root or core; the dependency remains
   `cli -> core`.

## Verification

- Unit-test all statuses with empty and non-empty reasons against existing text.
- Run existing CLI status tests to prove byte-for-byte compatibility.
- Build, import `formatRunFinalStatus` from `agent-quorum`, and typecheck a small
  consumer. Check both declared root export conditions continue resolving to the
  same built entry and that the bin still prints help.
- Run `pnpm run check` and `pnpm run test`.
