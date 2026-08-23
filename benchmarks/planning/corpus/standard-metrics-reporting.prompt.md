# Report critique iterations to readiness

Plan an additive `critiqueIterations` metric in schema-3 readiness proof,
`FinalProjection`, run records, summaries, and status output. It is the number
of structurally valid critic results accepted by semantic admission, including a
clean first review and excluding retries or invalid provider output.

Derive it from authoritative persisted state so resume does not double count.
The metric must not influence readiness, limits, quality policy, or exit codes.
Reject missing, corrupt, or unsupported proof rather than inventing a
compatibility value, and add focused unit and resume tests.
