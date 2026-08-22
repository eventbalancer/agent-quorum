# Extract terminal run finalization

Plan a behavior-preserving refactor of the plan-stage runner: extract the
terminal record, completion notification, report assembly, and cleanup sequence
from `src/stages/plan/run.ts` into a precisely named plan-stage module. Do not
change public APIs, artifacts, status classification, exit codes, provider calls,
or notification copy.

The plan must account for clean, needs-review, blocked, provider/preflight
failure, thrown errors, and signal teardown. Prefer tests around observable
ordering instead of source comments.
