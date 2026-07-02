# Phase P2 - Phase 2 work

This phase document is self-contained: goal, touch surfaces, steps, and acceptance gate are included so it can be executed on its own.

## Goal

- Deliver Phase 2 work.
- Done when: Phase 2 gate observable

## Pre-requisites

- [ ] Phase P1 (Phase 1 work) is complete and its acceptance gate is met.
- [ ] Dependencies satisfied: P1.
- [ ] `journal.md` current state matches the repository state.

## Phase Pins

| ID  | Action       | Touches             | Acceptance              |
| --- | ------------ | ------------------- | ----------------------- |
| P2  | Phase 2 work | `src/core/mod-2.ts` | Phase 2 gate observable |

## Preflight

Run before editing:

```bash
pnpm run types:check
```

Add narrower checks when this phase touches schemas, providers, the CLI, the public API, or generated artifacts.

## Steps

- Edit `src/core/mod-2.ts` to add the phase 2 behavior.
- Acceptance gate: phase 2 gate observable.

## Verification

- P2: `pnpm run test` proves phase 2 gate observable.

```bash
pnpm run check
```

## Acceptance Gate

- [ ] Phase 2 gate observable
- [ ] `journal.md` records progress and notes for P2.
- [ ] No unrelated files are included.

## Common Pitfalls

- Do not widen scope beyond P2.
- Do not edit generated artifacts (`dist/`, `coverage/`, lockfiles) by hand.
- Do not introduce destructive git or non-`pnpm` package commands.

## Stop Conditions

- Stop and write a stop report in `journal.md` (format in `run.md`) if a file, symbol, or interface named here is absent or materially different.
- Stop if the same check fails three times or edits start cycling.
