<!-- benchmark-reference-approval: operator-approval-required -->

# Summary Detail Projection

## Target behavior

Resolve `summaryDetail: compact | full` once with a `compact` default. Every
artifact and display consumes that resolved value; none may reinterpret raw CLI,
environment, or store input. The setting changes presentation only.

## Implementation

1. Add the literal union and optional operator-config field in the config model,
   mirror `compact` in defaults and `config.example.json`, and extend the existing
   scalar resolution chain with validation and provenance reporting.
2. Parse an additive `--summary-detail` override in the plan, launch, setup, and
   config-show surfaces that already own scalar settings. Forward it through the
   detached launch handoff.
3. Put the resolved value on `RunSettings`, then project it into run metadata and
   the durable run record. Additive readers default a missing legacy field to
   `compact`.
4. Have status and summary rendering branch only on `RunSettings.summaryDetail`.
   `full` may render already-computed reason codes and domain arrays; it must not
   mutate or reconstruct convergence state.
5. Keep JSON report fields additive and use the same resolved value in CLI and
   library runs.

## Verification

- Config tests cover default, store, environment, CLI precedence, invalid values,
  and the defaults/example mirror.
- Launch tests cover override serialization and child resolution.
- Metadata, run-store, status, and summary tests assert the same value and legacy
  fallback.
- A regression test proves `compact` and `full` produce identical convergence
  decisions for the same fixture.
- Update active docs and run `pnpm run check` plus `pnpm run test`.
