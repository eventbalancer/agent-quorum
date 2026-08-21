# Consolidate final status rendering without output changes

Plan a small, single-repository internal refactor in `src/cli/status.ts`.
Extract one private pure helper for the decision-and-reason suffix shared by the
`blocked` and `needs-review` branches of `printFinalArtifactStatus`. Keep the
helper in the same file and preserve the emitted bytes exactly, including ANSI
palette placement, punctuation, decision fallback, reason ordering, and the
current `unavailable` behavior for missing or empty reason codes.

Keep the ready exact-binding branch and the convergence-proof-unavailable
fallback unchanged. Do not add or rename CLI flags, exports, configuration,
artifacts, schemas, status values, or public types. Do not change readiness
classification or SHA-256 binding. The implementation boundary is only
`src/cli/status.ts` and focused assertions in
`tests/integration/status-launch.test.ts`; all other repositories and delivery
work are excluded.

Extend the existing final-artifact status coverage with byte-stable assertions
for `blocked` and `needs-review` records with empty, one, and multiple reason
codes. Preserve the stored order of multiple codes. Use the existing fixture
builders and run the focused status suite, followed by `pnpm run check` and
`pnpm run test`.

All operator-owned decisions are resolved above. This refactor has no data
migration, authorization, concurrency, production rollout, or cost change.
