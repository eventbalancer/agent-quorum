# Sample Large Plan - change pack

This directory is the execution pack for the plan above. `plan.md` is the authoritative master plan (a byte-for-byte copy of `plan.final.md`); the phase docs slice it into executable units.

## Bootstrap Order

Read these files in order at the start of every new session:

1. `README.md` - map, contract, and current route.
2. `journal.md` - current state, progress, plan deltas, and stop log.
3. `run.md` - execution protocol for one phase pin.
4. The current `phase-*.md` file selected from `journal.md`.
5. `plan.md` only by direct section reference from the phase file.

Phase docs carry enough context to implement one phase; consult `plan.md` only by direct section reference.

## Document Map

| File                | Role                                          | When to read                    |
| ------------------- | --------------------------------------------- | ------------------------------- |
| `README.md`         | Pack map and bootstrap contract               | First in every session          |
| `plan.md`           | Authoritative master plan and source of truth | By direct section reference     |
| `journal.md`        | Progress, blockers, deltas, restart context   | Before and after each phase pin |
| `run.md`            | Execution protocol                            | Before touching files           |
| `phase-*.md`        | Executable phase slices                       | One current phase at a time     |
| `remaining-debt.md` | Conscious non-scope and follow-up ledger      | Before final review             |

## Route

| Phase | File                      | Pins | Gate                    |
| ----- | ------------------------- | ---- | ----------------------- |
| P1    | `phase-1-phase-1-work.md` | P1   | Phase 1 gate observable |
| P2    | `phase-2-phase-2-work.md` | P2   | Phase 2 gate observable |
| P3    | `phase-3-phase-3-work.md` | P3   | Phase 3 gate observable |
| P4    | `phase-4-phase-4-work.md` | P4   | Phase 4 gate observable |

## Split Rationale

- AGENT_QUORUM_SPLIT=always: package emitted regardless of size (79 lines, 4 phases)
- Signals: 79 lines, 4 phases, 4 touched surfaces.

## Contract

- Use repository entry points: `pnpm run <script>` and `pnpm exec <bin>`; never `npx`.
- Do not commit or push unless the operator explicitly asks.
- Execute one phase pin at a time and keep scope limited to the current phase file.
- Update `journal.md` whenever reality diverges from the plan.
