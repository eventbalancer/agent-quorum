# Document live planning smoke result interpretation

Plan one documentation-only update to `docs/release.md`. Immediately after the
existing two-sentinel planning smoke command and its flow description, add a
short operator-facing subsection that explains how to read the committed
`smoke-results.json` contract:

- top-level `passed` is true only when both sentinel entries pass;
- each `tasks[]` entry reports `taskId`, `decision`, critique count, plan version,
  exit code, failures, and the final-plan path and digest when available;
- a failed smoke remains useful evidence and its per-task `summary.md`,
  `run.log`, `convergence.final.json`, and role artifacts should be inspected;
- generated output remains local outside the repository and is not committed.

Keep the existing merge-smoke versus release-calibration policy and every
command unchanged. Do not edit scripts, schemas, package metadata, source code,
other documentation files, or benchmark fixtures. Verify field names against
`benchmarks/planning/smoke-results.schema.json`, run Prettier on
`docs/release.md`, and run the focused planning-smoke unit test. All
operator-owned wording and scope decisions are resolved in this prompt.
