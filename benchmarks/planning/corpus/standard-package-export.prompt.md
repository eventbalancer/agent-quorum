# Export a final-status formatter

Plan an additive public helper `formatRunFinalStatus(status, reason)` that returns
the canonical one-line status text already used by the CLI. Move no orchestration
into the public surface. Preserve the root export map, `agent-quorum` bin, all
existing named exports, and existing status text byte-for-byte.

The implementation should establish one formatter owner shared by the CLI and
library export without violating architecture boundaries. Add source, built
package, types, and bin smoke coverage. No new dependency is allowed.
