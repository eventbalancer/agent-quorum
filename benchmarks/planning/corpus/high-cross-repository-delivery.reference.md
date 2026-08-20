<!-- benchmark-reference-approval: operator-approval-required -->

# Versioned Completion Webhook Delivery

## Boundary and current decision

The producer implementation can be planned locally. End-to-end rollout cannot be
declared ready until the dashboard owner confirms the consumer endpoint,
authentication scheme, accepted versions, idempotency key, and deployment path.
Record that material boundary challenge; unrelated repository topology is only
telemetry.

## Contract

- Versioned envelope: event version, event ID, run ID, terminal decision, stable
  reason codes, canonical plan SHA-256, and timestamp.
- Exclude prompts, plans, provider output, tokens, and unrestricted paths.
- Sign the exact serialized body using the operator-approved shared mechanism;
  bind signature metadata to its version.
- Delivery is at least once. The consumer deduplicates event ID; the producer
  retries bounded transient failures and persists attempt/result metadata.

## Delivery sequence

1. Obtain and freeze the missing consumer/auth/topology decisions in a shared
   wire-contract fixture. If unavailable, finish with `unable-to-decide` for
   delivery rather than inventing them.
2. Deploy a consumer that accepts v1 idempotently while no producer emits it.
3. Add opt-in producer config, secret lookup, payload construction, signing, and
   post-finalization dispatch behind one provider-neutral channel boundary.
4. Run contract fixtures against both repositories, then enable a canary producer
   and observe accepted, duplicate, retry, signature-failure, and redaction
   metrics.
5. Roll back by disabling producer emission; retain consumer v1 support through
   the compatibility window.

## Verification

- Producer tests cover exact payload, redaction, stable digest, retry classes,
  timeout, duplicate event ID, and disabled behavior.
- Shared consumer fixtures cover version rejection, signature verification, and
  idempotent replay.
- A staging end-to-end trace and owner sign-off are mandatory external evidence.
- Local missing repositories outside these named relations do not block producer
  unit readiness.
