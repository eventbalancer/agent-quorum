# Planning Benchmark Blind Review Rubric

Review every task independently. The two plans are deliberately labelled only
`A` and `B`; do not try to infer their origin.

For each task:

1. Check whether each plan is implementation-ready, scoped, compatible, and
   explicit about material failure modes.
2. Record only blocker or major findings. A blocker makes the proposed change
   unsafe or impossible; a major finding leaves a material correctness,
   compatibility, security, delivery, or verification gap.
3. Choose `A`, `B`, or `tie`. Prefer a plan only when it is materially safer or
   more implementation-ready, not because it is longer.
4. Use `knownConcernId` only when an adjudicator has mapped the finding to the
   committed concern catalog. Otherwise retain the finding as an additional
   material concern with its own concise claim.
5. Complete `knownConcernAssessments` for every committed concern against both
   plan A and plan B. Mark each one `addressed` or `missed` and cite concise
   plan evidence. `unreviewed` exists only in the generated template; scoring
   rejects a review while any assessment remains unreviewed or omitted.

Each review JSON must validate against `review.schema.json`. Reviewers must use
stable, distinct identifiers and must not coordinate their votes. At least two
independent complete reviews are required for scoring. A split vote is a tie;
strict majority determines `preferred` or `worse` when more than two reviews are
provided.

Release acceptance additionally requires operator approval of the corpus and
comparison plans. The committed v1 corpus intentionally declares
`operator-approval-required`; generated scores cannot self-certify that approval.
