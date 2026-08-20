# Authorize remote run interventions

Plan an authenticated HTTP endpoint for appending operator interventions to an
active run. The endpoint accepts a target run ID, permitted target role, message,
and idempotency key. It must authenticate the operator, authorize the run and
role, prevent cross-run writes and replay reordering, redact secrets, and retain
the existing CLI intervention path.

Use the current durable intervention ledger and run identity rules rather than a
parallel store. Define trust boundaries, failure semantics, audit fields,
concurrency behavior, tests, rollout, and rollback.

The operator has selected signed bearer tokens validated by an injected verifier.
The verified token supplies a stable operator subject ID, and a local policy maps
that subject to permitted run IDs and target roles. Signing keys, rotation, and
revocation remain external to the repository. Keep the endpoint disabled until
both the verifier and authorization policy are configured; do not invent a
second credential store.
