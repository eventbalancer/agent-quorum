# Deliver a versioned completion webhook across repositories

Plan a new optional completion webhook emitted by agent-quorum and consumed by a
separately deployed internal dashboard repository. The consumer checkout and
deployment topology are unavailable during planning. The event must contain a
version, run ID, terminal decision, stable reason codes, and plan digest; it must
not contain prompt or plan bodies.

Define the producer/consumer compatibility contract, authentication assumption,
retry/idempotency behavior, deployment order, observability, rollback, and the
specific evidence that cannot be proved without downstream access. Do not make
unrelated missing repositories block local producer work, but do not declare the
cross-repository delivery ready without the relationships required for rollout.
