# Report critique iterations to readiness

Plan an additive `critiqueIterations` metric in terminal convergence reports,
run records, summaries, and status output. It is the number of schema-valid
critic results applied to convergence state, including a clean first review and
excluding retries or invalid provider output.

Derive it from authoritative persisted state so resume does not double count.
The metric must not influence readiness, limits, quality policy, or exit codes.
Preserve legacy artifact reading and add focused unit and resume tests.
