# Project a configured summary detail level

Plan a new additive setting `summaryDetail` with values `compact` and `full` and
default `compact`. It must follow the existing default/store/environment/CLI
resolution model and appear in resolved configuration output, run metadata, the
durable run record, status output, and the final summary. `full` may add existing
reason-code and domain arrays to human status output; it must not change
convergence decisions or provider prompts.

Preserve old config files and public fields. Update the example config and the
relevant configuration, CLI, API, and artifact documentation. Include tests for
precedence and projection parity.
