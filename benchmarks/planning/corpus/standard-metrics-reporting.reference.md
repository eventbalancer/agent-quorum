<!-- benchmark-reference-approval: operator-approval-required -->

# Critique Iteration Metric

## Definition

`critiqueIterations` counts distinct schema-valid critic evaluations that strict
semantic admission accepted into schema-3 readiness proof. Provider retries,
malformed output, and replay of an already-applied evaluation do not increment
it. The value is telemetry, not a readiness input.

## Implementation

1. Add a persisted counter to `ReadinessProofState` and increment it through the
   admitted-critique transition, after closed-world validation and duplicate
   detection.
2. Accept the counter only from the current schema-3 proof. Missing, corrupt, or
   unsupported proof versions remain unproved rather than receiving a derived
   compatibility value. Never infer it from plan version because revisions and
   critiques are not one-to-one.
3. Add the number to the readiness portion of `FinalProjection`, then persist and
   render that supplied projection in the run record, API result, summary, and
   status. No renderer reads critique files independently.
4. Ensure resume reconciliation checks the applied evaluation identity before
   incrementing, including interruption between critique artifact persistence and
   readiness-proof persistence.

## Verification

- Unit tests cover clean first review = 1, revision review sequences, invalid
  output, retry, and duplicate replay.
- Resume fault-injection tests prove the counter is not charged twice.
- Projection tests assert schema-3 proof, `FinalProjection`, run record, summary,
  and status parity.
- A reducer regression test proves changing the metric cannot change decision,
  reason codes, limits, or `satisfied`.
- Run `pnpm run check` and `pnpm run test`.
