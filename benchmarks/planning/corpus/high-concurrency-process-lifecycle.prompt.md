# Make concurrent stop and exit finalization race-safe

Plan a fix for races among `intervene` stop requests, natural provider exit,
signal teardown, run-record finalization, and registry cleanup. A reused PID must
never cause an unrelated process or process group to be signalled. Concurrent
terminal paths must produce one durable terminal state and leave no child or
detached shell alive.

Use an additive selector-backed `intervene --stop` mode for immediate stop
requests and an additive `stopRun` public helper with the same semantics.
Existing `intervene` guidance behavior and the `interveneRun` signature must
remain unchanged. A stop request may signal only after validating the selected
run's PID, process group, and process start token.

Preserve supported platforms, selector behavior, terminal exit codes, and
best-effort cleanup semantics. Define state transitions, process identity,
locking or compare-and-set ownership, fault injection, stress tests, and
observability without broad destructive process commands.
