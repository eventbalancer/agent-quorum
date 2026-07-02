# Phase P3 - Phase 3 work

This phase document is self-contained: goal, touch surfaces, steps, and acceptance gate are included so it can be executed on its own.

## Goal

- Deliver Phase 3 work.
- Done when: Phase 3 gate observable

## Pre-requisites

- [ ] Phase P2 (Phase 2 work) is complete and its acceptance gate is met.
- [ ] Dependencies satisfied: P2.
- [ ] `journal.md` current state matches the repository state.

## Phase Pins

| ID  | Action       | Touches             | Acceptance              |
| --- | ------------ | ------------------- | ----------------------- |
| P3  | Phase 3 work | `src/core/mod-3.ts` | Phase 3 gate observable |

## Preflight

Run before editing:

```bash
pnpm run types:check
```

Add narrower checks when this phase touches schemas, providers, the CLI, the public API, or generated artifacts.

## Steps

- Edit `src/core/mod-3.ts` to add the phase 3 behavior.
- Acceptance gate: phase 3 gate observable.

## Verification

- P3: `pnpm run test` proves phase 3 gate observable.

```bash
pnpm run check
```

## Acceptance Gate

- [ ] Phase 3 gate observable
- [ ] `journal.md` records progress and notes for P3.
- [ ] No unrelated files are included.

## Common Pitfalls

- Do not widen scope beyond P3.
- Do not edit generated artifacts (`dist/`, `coverage/`, lockfiles) by hand.
- Do not introduce destructive git or non-`pnpm` package commands.

## Stop Conditions

- Stop and write a stop report in `journal.md` (format in `run.md`) if a file, symbol, or interface named here is absent or materially different.
- Stop if the same check fails three times or edits start cycling.
