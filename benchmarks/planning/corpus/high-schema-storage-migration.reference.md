<!-- benchmark-reference-approval: operator-approval-required -->

# Run Record Schema v2 Migration

## Safety invariants

- Only schema-valid v2 evidence may project `ready`.
- A v1 record remains addressable but migrates to an explicitly unproved state.
- Readers never mutate source bytes; the existing atomic writer owns upgrades.
- Malformed and unknown-future versions are skipped and preserved for diagnosis.

## Implementation

1. Add explicit `schemaVersion` and v2 terminal decision/reason-code fields to the
   run-record contract. Keep old public fields as compatibility projections.
2. Parse JSON as unknown, validate the version-specific shape, and normalize to
   an internal record. Map v1 terminal records conservatively to
   `unable-to-decide` with `legacy-fresh-review-required`; never derive `ready`
   from `finalStatus=clean` or `satisfied=true`.
3. Keep read/list/select/prune functions side-effect free. When a normalized v1
   record is next patched, the sole run-store writer emits v2 through its sibling
   temporary file and atomic rename.
4. Preserve fixed run ID, ordering, timestamps, process identity, work/log paths,
   and legacy fields. A crash before rename leaves v1 readable; a crash after
   rename leaves complete v2.
5. Gate any later promotion to `ready` on a fresh convergence artifact whose run
   ID and exact plan digest match the record. Unknown versions are telemetry and
   are never overwritten by this binary.

## Verification and rollout

- Golden fixtures cover active/terminal v1, v2, malformed JSON, unsupported
  future version, and missing optional legacy fields.
- Fault injection covers temp write, fsync/rename boundary, process interruption,
  concurrent list, retry, and pruning during migration.
- Status/selectors remain stable while legacy decisions show unproved reason
  codes.
- Ship the read-compatible code before any writer relies on v2-only data. Rollback
  remains possible because compatibility fields stay populated.
- Run `pnpm run check` and `pnpm run test`.
