# Add an optional machine-readable result file

Plan an additive `--result-json <file>` option for `agent-quorum plan` and
`agent-quorum launch`. When present, the terminal `RunReport` must be written
atomically to that path after normal finalization. The library `runPlanLoop`
surface should accept the same optional path. Existing positional-plan and
`--prompt` invocation forms, stdout/stderr, exit codes, and default artifact
locations must remain unchanged when the option is absent.

Keep the public bin and root package export stable. Cover direct CLI execution,
launch forwarding, library use, invalid/missing values, and a failed run that
still has a terminal report. Do not add a new output format or alter report
fields.
