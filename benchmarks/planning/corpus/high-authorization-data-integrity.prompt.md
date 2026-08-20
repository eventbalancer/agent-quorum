# Authorize remote run interventions

Plan an authenticated HTTP endpoint for appending operator interventions to an
active run. The endpoint accepts a target run ID, permitted target role, message,
and idempotency key. It must authenticate the operator, authorize the run and
role, prevent cross-run writes and replay reordering, redact secrets, and retain
the existing CLI intervention path.

Use the current durable intervention ledger and run identity rules rather than a
parallel store. Define trust boundaries, failure semantics, audit fields,
concurrency behavior, tests, rollout, and rollback. Authentication technology is
not yet selected, so identify the required operator decision instead of choosing
credentials implicitly.
