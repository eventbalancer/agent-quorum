<!-- benchmark-reference-approval: operator-approval-required -->

# Optional Result JSON Delivery

## Intent and boundaries

Add one opt-in destination for the existing terminal `RunReport`. Preserve all
current input modes, logging, artifacts, exit codes, package exports, and bin
resolution. The destination is not a new report schema.

## Implementation

1. Extend the plan-stage parser with `--result-json <file>` and
   `--result-json=<file>`. Reject an empty value through the existing usage-error
   path without changing positional input or `--prompt` precedence.
2. Carry the resolved absolute path as an optional run override. Add the same
   optional field to the public `runPlanLoop` options and its argument builder.
3. Teach `launch` to validate and forward the flag unchanged to the detached
   child. The parent must not create the file because only the child owns the
   terminal report.
4. At the single point where `runPlanLoopCli` has its terminal report and exit
   code, serialize the existing report with a trailing newline and atomically
   rename a sibling temporary file. Attempt this for every branch that returns a
   report, including non-clean terminal outcomes; do not synthesize a report for
   preflight failures that currently return none.
5. Treat an unwritable requested destination as an operator-facing failure while
   preserving the already-produced run artifacts and finalized ledger record.

## Interfaces and compatibility

- `--result-json` is optional on `plan` and `launch`.
- The public options type gains only `resultJsonPath?: string`.
- `RunReport`, package exports, the `agent-quorum` bin, and default behavior are
  unchanged.

## Verification

- Parser tests cover positional plan, `--prompt`, both new flag spellings,
  missing values, and duplicate-input rejection.
- Launch handoff tests prove the child receives the path and the parent does not
  write it.
- Integration tests cover clean and needs-review reports, atomic replacement,
  relative-path resolution, and write failure.
- Build and import the package to exercise the additive library option, then run
  `pnpm run check` and `pnpm run test`.
