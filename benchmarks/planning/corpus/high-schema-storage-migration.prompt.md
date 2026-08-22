# Migrate durable run records to schema version 2

Plan a version-2 durable run-record schema that adds a normalized terminal
readiness decision and stable reason codes. Existing version-1 records must
remain readable. A legacy record cannot be treated as proven ready solely from
its old `finalStatus` or `satisfied` fields; it needs a fresh validated report
before promotion.

Migration occurs lazily on read/write and must preserve atomic replacement,
concurrent readers, crash recovery, pruning, selectors, and status listing.
Malformed or future-version records remain isolated rather than rewritten.
Define compatibility, fault-injection tests, and a rollback-safe delivery path.
