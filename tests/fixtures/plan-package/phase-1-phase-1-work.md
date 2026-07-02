# Phase P1 - Phase 1 work

This phase document is self-contained: goal, touch surfaces, steps, and acceptance gate are included so it can be executed on its own.

## Goal

- Deliver Phase 1 work.
- Done when: Phase 1 gate observable

## Pre-requisites

- [ ] Baseline checks are green or explicitly documented in `journal.md`.
- [ ] Dependencies satisfied: requirements.
- [ ] `journal.md` current state matches the repository state.

## Phase Pins

| ID  | Action       | Touches             | Acceptance              |
| --- | ------------ | ------------------- | ----------------------- |
| P1  | Phase 1 work | `src/core/mod-1.ts` | Phase 1 gate observable |

## Preflight

Run before editing:

```bash
pnpm run types:check
```

Add narrower checks when this phase touches schemas, providers, the CLI, the public API, or generated artifacts.

## Steps

- Edit `src/core/mod-1.ts` to add the phase 1 behavior.
- Acceptance gate: phase 1 gate observable.

## Verification

- P1: `pnpm run test` proves phase 1 gate observable.

```bash
pnpm run check
```

## Acceptance Gate

- [ ] Phase 1 gate observable
- [ ] `journal.md` records progress and notes for P1.
- [ ] No unrelated files are included.

## Common Pitfalls

- Do not widen scope beyond P1.
- Do not edit generated artifacts (`dist/`, `coverage/`, lockfiles) by hand.
- Do not introduce destructive git or non-`pnpm` package commands.

## Stop Conditions

- Stop and write a stop report in `journal.md` (format in `run.md`) if a file, symbol, or interface named here is absent or materially different.
- Stop if the same check fails three times or edits start cycling.
