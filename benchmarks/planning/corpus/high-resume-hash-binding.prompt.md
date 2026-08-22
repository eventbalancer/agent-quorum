# Make resume proof reuse exact and idempotent

Plan changes so a resumed planning run reuses critic, deterministic-system, and
Judge evidence only when artifact schema, plan version, and SHA-256 all match the
exact candidate bytes. Simulate interruption after each artifact write and after
each convergence-state write. Reconciliation must not repeat a provider call,
increment critique counts, or consume iteration/issue appetite twice.

Legacy artifacts without complete binding remain useful history but require a
fresh review. Preserve existing resume CLI behavior, archival conventions, and
terminal exit codes. Include tamper, status-only rebind, and partial-write tests.
