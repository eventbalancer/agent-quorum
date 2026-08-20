<!-- benchmark-reference-approval: operator-approval-required -->

# Authorized Remote Interventions

## Boundary decision

Freeze the authenticated subject and authorization-policy contract before
implementation. Because the credential mechanism is not selected, endpoint
readiness is `unable-to-decide` until the operator chooses an identity verifier,
key rotation/revocation path, and subject-to-run authorization source. Do not
store or invent credentials in repository config.

## Security and integrity invariants

- Verify identity before resolving mutable run state, then authorize subject,
  exact run ID, and requested role before ledger mutation.
- Bind the idempotency key to subject, run ID, role, and message digest.
- One existing append owner serializes CLI and HTTP writes; neither path owns a
  second ledger.
- Audit metadata contains subject ID, request ID, authorization result, run ID,
  role, message digest, and timestamp, never the secret or raw message.

## Implementation after the decision

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
