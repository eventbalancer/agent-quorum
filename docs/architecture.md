# Architecture

## Roles and providers

Five roles drive the loop, each resolved to a provider through
`plan-loop.json` (`env > file` per field):

| Role       | Purpose                                            | Mode                   |
| ---------- | -------------------------------------------------- | ---------------------- |
| critic     | finds issues in the current plan                   | JSON (critique schema) |
| creator    | creates plan.v0 and applies critique verdicts      | markdown + JSON        |
| fixer      | proposes/applies reference fixes after convergence | markdown               |
| reviewer   | reviews the fixer's proposal                       | JSON (review schema)   |
| translator | renders the Russian companion plan                 | markdown               |

Three provider adapters share one entry point (`providerRun`) that owns the
single retry wrapper:

- **codex** — stateless `codex exec --sandbox read-only` with `--output-schema`;
  markdown-mode roles go through a `plan_markdown` wrapper schema.
- **claude** — `claude -p --verbose --output-format stream-json` with
  `--append-system-prompt`, `--permission-mode plan` (the translator overrides
  to `default`), config-driven `--tools/--allowed-tools/--disallowed-tools`,
  and `--session-id/--resume` session continuity with a stall-resume-once then
  re-establish self-heal.
- **cursor** — `cursor-agent -p --output-format stream-json` with
  capability-probed `--trust/--approve-mcps`; tool and schema constraints are
  injected as prompt hints; the session id is captured from the result event.

Write prevention: no role is ever granted Write/Edit/NotebookEdit. Shell access
exists only where the packaged config grants it — creator create mode — under
claude's plan permission mode.

## The loop

Per iteration: critic → sanitize → schema-validate (exit 3) → health metrics →
converge on zero issues; otherwise creator update → converge on zero accepted
blockers/majors, on a `diff` below `diffThreshold`, or at `iters` (the last
revision becomes final). Effort shapes the topology: `low` runs the creator
one-shot (plan + metadata in one JSON call, with a split-call fallback), `high`
splits markdown and metadata, `max` additionally disables provider sessions.

Post-convergence: the reference validator mines `file:line` tokens out of code
spans, resolves them against an in-process workspace snapshot, and writes
`findings.json`; the fix pass proposes → reviews → applies (every failure path
keeps the converged plan); the final status computes clean / needs-review /
blocked; the non-fatal translate pass renders `plan.final.ru.md`; `summary.md`
closes the run.

## Artifact contract ($WORK)

`plan.vN.md`, `critique.vN.json`, `update.vN.json`, `update-meta.vN.json`,
`plan.revision.vN.md`, `*.raw` normalization sidecars, `plan.final.md`,
`plan.final.before-fix.md`, `fix-proposal.md`, `fix-review.json`,
`fix-applied.md`, `plan.final.ru.md`, `findings.json`, `summary.md`,
`rejected-log.jsonl`, `operator-interventions.jsonl`,
`operator-intervention-migrations.jsonl`, `clarify-questions.json`,
`clarify-answers.jsonl`, `clarify.offset`, `clarify.done`, `prompt.md`,
`run.meta.tsv`, `run.log`, `creator.session-id`, and `stale.<timestamp>/`
archives on resume. A registry copy of `run.meta.tsv` lives in
`<state-dir>/<pid>.tsv` while the run is alive.

## Watchdog and process hygiene

Claude and cursor calls stream NDJSON through an in-process watchdog with three
independent guards: byte-idle, semantic-idle (assistant/tool/thinking/result
events count as progress), and wall-clock. On trigger: SIGINT → grace → SIGTERM
to the provider's process group; the call reports stall status 124. Providers
spawn detached (own process group) so TERM/INT teardown kills whole subtrees;
the runner exits 143 on signal.

## Resume and interventions

`PLAN_LOOP_RESUME=1` finds the last stable plan (highest `plan.vN.md` whose
`update.v(N-1).json` validates), archives stale artifacts to
`stale.<timestamp>/`, and continues. Operator interventions append to a JSONL
ledger; active entries are injected into critic/creator/fixer/reviewer prompts
and marked migrated once a revision lands.
