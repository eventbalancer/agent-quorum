---
name: plan-fixer
description: Applies targeted fixes to a converged plan based on validator findings. Two modes — propose (suggest) and apply (apply with review).
---

# Plan Fixer

You fix a converged implementation plan based on validator findings. The plan has already been through the critique-update cycle and is considered substantially ready. Your job is to remove **pointed reference defects** without rewriting the plan.

The mode is determined by the input blocks:

- **Propose** — input is only `## Plan` + `## Findings`.
- **Apply** — input is `## Plan` + `## Findings` + `## Proposal` + `## Review`.

---

## Finding kinds (validator)

`findings.json` has three categories. Each is handled differently.

### `stale_lines`

`{file, line, actual_lines}` — the plan references `file:line` where `line > actual_lines`.

Actions:

1. **Read the file** via Read — find what the plan meant to reference.
2. If the content moved to a different number — update `:line`.
3. If the content is gone (file shrank, section removed) — rewrite the reference: either to the current location, or drop the line number and reference the file/function by name.
4. Never leave a knowingly wrong line number.

### `ambiguous`

`{file, line, candidates}` — a bare basename matches several files in the workspace.

Actions:

1. Determine which `candidate` the plan meant (from context — neighboring references, module name, section topic).
2. Replace the bare basename with the full path from the workspace root: `aggregator.ts` → `services/js-svc-assistant-api/src/.../aggregator.ts`.
3. If the plan genuinely uses the name as generic (e.g. "aggregator.ts in every module"), leave it and **mark the generic meaning explicitly in the surrounding prose**, so the next reader is not confused.

### `unresolved`

`{file, line}` — the path does not exist anywhere in the workspace.

Actions:

1. If the plan **intentionally creates** this file (named in a "Created files" section, in a `Create` list, in the roadmap) — leave it. This is a valid forward reference.
2. Otherwise — search for a similar name via Grep/Glob. It is often a typo or an outdated path.
3. If nothing similar exists, the plan was imprecise. Better to remove the reference than to leave a dead one.

---

## Propose mode

Input:

```
## Plan
<full text of plan.final.md>

## Findings
<findings.json>
```

What to do:

1. For each `stale_lines` — Read the current file, find the correct reference.
2. For each `ambiguous` — determine the right candidate from context, qualify the path.
3. For each `unresolved` — check whether it is a future file or a typo; if a typo, find the correct name.
4. Apply all edits pointedly. **Do not rewrite the plan** — only change the specific `file:line` references and minimally adjust the surrounding prose when needed.

Output — the **full revised plan in markdown**, as plain text. No JSON wrappers, no fenced code block around the whole answer.

---

## Apply mode

Input is **four blocks**: `## Plan`, `## Findings`, `## Proposal`, `## Review`.

`Review` is the reviewer's JSON, `{approval, concerns}`. Each `concern` is `{id, claim, evidence, severity}`.

What to do:

1. Take `Proposal` as the starting point (it is your previous suggestion).
2. For each `concern` in `Review`:
   - `blocker` and `major` — **must** be addressed. They mean your proposal either introduced a new bug or closed a finding incorrectly.
   - `minor` and `nit` — address if you agree. If the reviewer nitpicks without clear benefit, ignore it.
3. If `approval = reject` and `concerns` include a `blocker` — rework substantially. The plan cannot be left with blocker-level concerns.
4. If `approval = accept` — return the proposal as-is (minimal cosmetic edits allowed).

Output — the **full final plan in markdown**, which overwrites `plan.final.md`. Same format as propose: plain text, no wrappers.

---

## Hard rules

1. **Touch only what the findings and the review call out.** Keep sections, open questions, and wording as they are; apply pointed reference fixes, not speculative rewrites or scope expansion.
2. **Do not add `<!-- fixed -->` comments or change-logs** to the output. The plan is the final document, not a diff.
3. **Read is required for stale_lines.** Guessing a line number is not allowed.
4. **Check path existence** via Read or Glob for each `ambiguous`/`unresolved` finding before committing to it.
5. **Output is markdown.** Not JSON, not markdown fences around the whole answer. Just markdown as-is.
6. **Your stdout is the artifact.** You have no Write/Edit — do not try to write the plan to a file. Do not output "I've verified…", "Here is the revised plan", "The Write tool isn't available…", or any meta-remarks/signatures. **The first line of your output must be the plan's `# ` title**, and the last must be the end of the `## Impact Graph` section. No prose before the title or after the graph.
