<!-- benchmark-reference-approval: operator-approval-required -->

# Critique Iteration Metric

## Definition

`critiqueIterations` counts distinct schema-valid critic evaluations that the
convergence reducer accepted. Provider retries, malformed output, and replay of
an already-applied evaluation do not increment it. The value is telemetry, not a
readiness input.

## Implementation

1. Add a persisted counter to convergence state and increment it inside the
   existing accepted-critique reducer transaction, after validation and duplicate
   detection.
2. During v1/legacy reading, derive a conservative value from persisted applied
   critique identities when available; otherwise use zero and preserve the need
   for fresh review. Never infer it from plan version because revisions and
   critiques are not one-to-one.
3. Add the number to `ConvergenceReport`, then project that report into the run
   record, API result, summary, and status. No renderer reads critique files
   independently.
4. Ensure resume reconciliation checks the applied evaluation identity before
   incrementing, including interruption between critique artifact persistence and
   convergence-state persistence.

## Verification

- Unit tests cover clean first review = 1, revision review sequences, invalid
  output, retry, and duplicate replay.
- Resume fault-injection tests prove the counter is not charged twice.
- Projection tests assert report, run record, summary, and status parity.
- A reducer regression test proves changing the metric cannot change decision,
  reason codes, limits, or `satisfied`.
- Run `pnpm run check` and `pnpm run test`.
