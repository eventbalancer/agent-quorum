# Task: add a `--quiet` flag to the core run

## Goal

Let a caller suppress the per-iteration progress chatter that `agent-quorum`
prints to stderr during a run, keeping only the final summary line. Useful when
the loop is driven from a script that captures the structured result itself.

## What we know

- The core run entry point is `src/stages/plan/run.ts`; its argument parser is
  `parseRunArgs`.
- Progress and warnings are emitted through `src/runtime/log.ts`.
- The flag should be off by default, so existing output is unchanged.

## Constraints

- Do not change the structured `RunResult` returned by the public API.
- `--quiet` only affects stderr progress; errors must still surface.
- Keep the plan usage text in `src/stages/plan/run.ts` in sync.

## Done when

- `agent-quorum plan --quiet <plan.md>` runs the loop without per-iteration progress.
- The summary line and any error output still appear.
- A test covers the quiet path.
