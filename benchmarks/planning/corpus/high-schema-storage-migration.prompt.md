# Migrate durable run records to schema version 2

Plan a version-2 durable run-record schema that adds terminal-verification
provenance to the current version-1 `FinalProjection`. Existing version-1
records must remain addressable. A version-1 record cannot be treated as
current proof solely from `final.status` or `final.readiness.satisfied`; it needs
a fresh schema-3 readiness proof whose canonical identity and occurrence
projection agree before promotion.

Migration occurs lazily on read/write and must preserve atomic replacement,
concurrent readers, crash recovery, pruning, selectors, and status listing.
Malformed or future-version records remain isolated rather than rewritten.
Define compatibility, fault-injection tests, and a rollback-safe delivery path.
