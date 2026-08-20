<!-- benchmark-reference-approval: operator-approval-required -->

# Authorized Remote Interventions

## Frozen operator decisions

Use signed bearer tokens behind an injected verifier. Treat the verifier's stable
subject ID as the authenticated identity, and authorize it through a local policy
mapping subjects to exact run IDs and target roles. Signing keys, rotation, and
revocation stay outside the repository. Keep the endpoint disabled until both
the verifier and policy are configured; do not add a second credential store.

## Security and integrity invariants

- Verify identity before resolving mutable run state, then authorize subject,
  exact run ID, and requested role before ledger mutation.
- Bind the idempotency key to subject, run ID, role, and message digest.
- One existing append owner serializes CLI and HTTP writes; neither path owns a
  second ledger.
- Audit metadata contains subject ID, request ID, authorization result, run ID,
  role, message digest, and timestamp, never the secret or raw message.

## Implementation

1. Add the verifier behind an injected boundary and fail closed on unavailable,
   expired, revoked, malformed, or wrong-audience credentials.
2. Resolve run identity using durable run ID plus live process start token; reject
   ambiguous names and terminal or replaced processes.
3. Under the existing append lock/atomic-write path, check the bound idempotency
   identity, append once, and return the prior result for exact replay. Reject key
   reuse with different bound data.
4. Keep CLI behavior unchanged by routing both entry points through the same
   authorization-neutral ledger append primitive.

## Verification and rollout

- Test cross-run and cross-role attempts, revoked/expired identities, replay,
  conflicting key reuse, concurrent CLI/HTTP append, process replacement,
  audit redaction, and crash recovery.
- Deploy disabled, configure approved verifier/authorization policy externally,
  canary authorized and denied requests, then enable per operator group.
- Roll back by disabling HTTP while preserving the ledger and CLI path.
