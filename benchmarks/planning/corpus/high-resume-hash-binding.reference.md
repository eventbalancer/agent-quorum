<!-- benchmark-reference-approval: operator-approval-required -->

# Exact Proof Resume Binding

## Proof identity

Use a stable evaluation identity derived from role, schema version, plan version,
canonical plan SHA-256, and evaluation kind. No evidence contributes to readiness
until both its validated artifact and an applied-evaluation ledger entry agree on
that identity.

## Implementation

1. Persist plan version and SHA-256 in critic, system-check, Judge, and convergence
   artifacts. Validate schema and semantic consistency before computing the
   evaluation identity.
2. Write a provider result to its versioned artifact atomically, then apply it to
   convergence state with the same identity. Persist applied identities and all
   associated counters/limits in one atomic state replacement.
3. On resume, hash current candidate bytes first. Reconcile a valid unapplied
   artifact exactly once; ignore an already-applied identity; archive partial,
   invalid, version-mismatched, or digest-mismatched output before scheduling a
   fresh call.
4. Treat legacy evidence without complete identity as history and add a
   fresh-review reason. It may seed context but cannot satisfy a readiness gate.
5. Define the sole status-only rebind: project status, recompute canonical digest,
   rerun deterministic binding and any required Judge under the rule that status
   alone cannot alter semantic verdict. Any other byte change invalidates all
   exact-plan proof.

## Verification

- Fault-inject before/after every artifact and convergence-state rename for each
  evidence kind; resume must produce one applied identity, one counter increment,
  and no duplicate provider call.
- Tamper plan bytes, artifact version, digest, verdict, and applied ledger; each
  case requires fresh evidence or terminates unable to decide.
- Test clean status-only fixed point and inconsistent rebind.
- Preserve CLI/archive/exit behavior and run `pnpm run check` plus
  `pnpm run test`.
