<!-- benchmark-reference-approval: operator-approval-required -->

# Race-Safe Process Finalization

## Invariants

- A signal target is valid only when PID, process group, and process start token
  all match the durable run identity immediately before signalling.
- One terminal compare-and-set owner writes the final record; later terminal
  attempts observe it and perform idempotent cleanup only.
- Registry removal cannot make a still-live owned process unreachable.
- Teardown targets only the validated run process group and never a broad or
  unresolved identifier.

## Implementation

1. Model running -> stopping -> terminal transitions with stable transition IDs
   in the durable record. Preserve existing final state and exit-code vocabulary.
2. Centralize live identity validation using PID, PGID, and platform start token.
   Revalidate immediately before TERM/KILL escalation and abort on any mismatch.
3. Acquire terminal ownership through an atomic record compare-and-set or
   equivalent per-run lock. Natural exit and stop paths submit facts to that same
   owner; the winner finalizes, and the loser never overwrites terminal data.
4. Order teardown as: mark stopping, signal validated group, wait bounded grace,
   escalate only if identity still matches, reap children, finalize record, then
   remove registry. Recovery reconciles stopping records before accepting new
   intervention.
5. Emit structured transition, identity-mismatch, escalation, and cleanup outcome
   metadata without command bodies or plan content.

## Verification

- Deterministic fault injection pauses at every transition and runs stop, natural
  exit, and cleanup in both orders.
- Simulate PID reuse, PGID change, missing start token, double stop, parent crash,
  child exit, and escalation timeout; assert no unrelated signal target.
- Stress many loopback fake-provider runs and assert one terminal record, stable
  exit code, empty owned process group, and removed registry.
- Run platform-gated process tests plus `pnpm run check` and `pnpm run test`.
