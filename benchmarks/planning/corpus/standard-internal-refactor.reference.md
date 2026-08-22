<!-- benchmark-reference-approval: operator-approval-required -->

# Terminal Finalization Refactor

## Refactor boundary

Extract only the repeated terminal orchestration after the runner has enough
facts to finish. Leave planning, provider execution, classification, and CLI
parsing in their current owners.

## Implementation

1. Inventory every return and catch/finally path in the plan runner, recording
   which paths own a `RunReport`, terminal ledger patch, completion notification,
   run-log sink, registry cleanup, scratch cleanup, and signal teardown.
2. Introduce a plan-stage `run-finalization.ts` module with a typed input carrying
   the already-computed state, exit code, optional report facts, and injected I/O
   callbacks. It returns the existing `RunOutcome` and does not classify facts.
3. Move terminal record patching and at-most-once notification into the helper.
   Keep cleanup in a `finally`-equivalent path so notification or report-write
   failure cannot skip registry, log, scratch, or signal cleanup.
4. Replace the existing branches incrementally, retaining the original order:
   finalize durable state, emit completion when eligible, return outcome, and
   always release process-local resources.
5. Delete only duplication proven unreachable after all call sites use the new
   helper. Do not export it from the package root.

## Verification

- Add table-driven tests for clean, needs-review, blocked, early provider failure,
  thrown error, and notification failure.
- Assert exactly one terminal record mutation and at most one notification, plus
  cleanup on every branch.
- Retain existing integration snapshots for report fields, status, reason, and
  exit code.
- Run `pnpm run check` and `pnpm run test`; compare representative pre/post run
  artifacts byte-for-byte except timestamps and identifiers.
