# API

```ts
import {
  runPlanLoop,
  launchPlanLoop,
  getRunStatus,
  addIntervention,
  listRuns,
  getRun,
  getRunLogPath,
  interveneRun,
  pruneRuns,
  ExitCode,
  RUN_RECORD_SCHEMA_VERSION,
  type RunPlanLoopOptions,
  type LaunchPlanLoopOptions,
  type RunResult,
  type RunHealth,
  type RunFinalStatus,
  type FinalProjection,
  type ReadinessProofProjection,
  type JudgeProofProjection,
  type OccurrenceCoverageProjection,
  type OccurrenceSourceProjection,
  type LaunchResult,
  type CommandResult,
  type InterventionTarget,
  type RunLookupOptions,
  type RunRecord,
  type RunSelector,
  type RunState,
  type RetentionPolicy,
  type PruneResult,
  type Role,
  type Runner,
  type Quality,
  type CompletenessPromise,
  type ReadinessDecision,
  type RiskApplicability,
  type RiskLevel,
  type RiskDomain,
  type ReadinessLimit,
} from 'agent-quorum';
```

The API is a thin, semver-deliberate surface over the same engine the CLI
uses. Functions return results; only the CLI calls `process.exit`. Operational
logging still goes to stderr and follows the CLI's metadata-only provider log
contract: normal logs omit prompt, plan, source, tool-argument, and raw provider
stderr bodies.

## Importing from CommonJS

The package ships a single ESM build, but Node ≥ 24 (already required by
`engines`) loads a synchronous ESM graph through `require()` natively, so a
CommonJS consumer works without a dual build:

```js
const { runPlanLoop, ExitCode } = require('agent-quorum');
```

For TypeScript consumers this resolution needs TS ≥ 5.8 with
`"module": "nodenext"`. On older toolchains, fall back to a dynamic import:

```js
const { runPlanLoop } = await import('agent-quorum');
```

`require.resolve('agent-quorum/package.json')` is also supported.

## runPlanLoop(options)

Runs the core loop to completion in-process.

```ts
const result = await runPlanLoop({
  input: 'my-plan.md', // plan file, or prompt file with prompt: true
  prompt: false,
  iters: 3,
  quality: 'balanced', // 'quick' | 'balanced' | 'thorough'
  fix: true,
  locale: 'ru', // optional; localizes Telegram interaction + final companion plan
  translate: false, // optional compatibility toggle
  workDir: '/abs/path/loop-my-plan', // optional; takes precedence over AGENT_QUORUM_WORK_DIR
  config: { settings: { diffThreshold: 8 }, telegram: { chatId: '123' } }, // optional structured override
  secrets: { telegramBotToken: '...' }, // optional; never mutates process.env
});
// result: {
//   exitCode: 0,
//   workDir: '/abs/path/loop-my-plan',
//   finalPlanPath: '/abs/path/loop-my-plan/plan.final.md',
//   summaryPath: '/abs/path/loop-my-plan/summary.md',
//   iterations: 2,
//   health: { critic: 3, addressed: 2, new: 1, invalid: 0, validAddressedPct: 66 },
//   splitDecision: 'no-split',          // 'split' | 'no-split', present every run
//   packageDir: undefined,              // '/abs/path/loop-my-plan/plan.package' only when split
//   final: {
//     status: 'clean',
//     reasons: [],
//     structuralStatus: 'clean',
//     structuralReason: '',
//     artifactPath: '/abs/path/loop-my-plan/convergence.final.json',
//     readiness: {
//       proofArtifactPath: '/abs/path/loop-my-plan/convergence.final.json',
//       planVersion: 2,
//       canonicalPlanSha256: '…',
//       decision: 'ready',
//       reasonCodes: [],
//       satisfied: true,
//       exhaustedLimits: [],
//       unresolvedProofIds: [],
//       applicableRiskDomains: ['correctness'],
//       highRiskDomains: ['correctness'],
//       opportunityCount: 0,
//       occurrenceCoverage: {
//         // trusted catalog, source requirements/snapshots, normalized outcomes,
//         // resolved/violated/unresolved/disagreement ids, and proof flags
//       },
//     },
//     judge: {
//       required: true,
//       allowed: true,
//       evaluated: true,
//       available: true,
//       candidateUnchanged: true,
//       verdict: true,
//       rationale: 'Ready.',
//       binding: { candidate: { kind: 'canonical-plan', planVersion: 2, contentDigest: '…' }, lineage: { evaluationStage: 'final-readiness', lineageDigest: '…' } },
//       metadataPath: '/abs/path/loop-my-plan/judge.final.meta.json',
//     },
//   },
// }
```

`exitCode` follows the CLI contract (`ExitCode.Ok`, `ExitCode.SchemaInvalid`,
`ExitCode.Blocked`, …). The structured fields are built from the same data that
renders `summary.md`: `health` carries exactly the numbers of the `final_health`
line, and `iterations`/`finalPlanPath`/`summaryPath` mirror their summary lines.
Path fields are present only when the file exists, and failure exits may carry
`workDir` alone. `splitDecision` (`'split'` | `'no-split'`) mirrors the
`split_decision` summary line and is present whenever `plan.split.json` was
written; `packageDir` is present only when the split policy fired and a
`plan.package/` was emitted. `runId` and `name` identify the run across every
start and lookup surface.

A run that reaches finalization exposes one readiness-bearing object:
`RunResult.final`. The
same `FinalProjection` is persisted as `RunRecord.final` and supplied to the
summary, CLI, status, and notification renderers; those consumers do not
recompute readiness. Its fields have distinct ownership:

- `status`, `reasons`, `structuralStatus`, and `structuralReason` report the
  overall and independent structural outcomes;
- `readiness` carries the schema-3 proof path, plan version, canonical SHA-256,
  four-way decision, stable reason codes, limits, unresolved proof IDs, risk
  domains, opportunities, and canonical occurrence coverage;
- `judge.required` distinguishes exemption from unavailable evidence, while
  `allowed`, `evaluated`, `available`, `candidateUnchanged`, `verdict`,
  `rationale`, and the optional exact binding/metadata path describe the final
  Judge source without standing in for the overall decision.

`ready` with exact compatible proof projects to `clean`. Structurally broken
output projects to `blocked`, skips final Judge evaluation, and exits 6. Every
usable but incomplete, negative, unavailable, inconsistent, stale, or
mismatched result projects to `needs-review` and exits 0. `ReadinessLimit` is
the closed set `issue-budget | iteration-cap | assurance-appetite`; configured
input sizing remains telemetry and is not a readiness limit. `LaunchResult`
does not contain `final` because detachment happens before completion.

This is an intentional breaking boundary. The former flat status, structural,
Judge-readiness, and convergence fields are not populated or adapted. Durable
run records require `schemaVersion: 1`; ledger discovery skips absent,
unsupported, or malformed record schemas rather than manufacturing current
proof from them.
Artifacts land in the resolved workdir; for `home`/`workDir` the precedence is
option > environment variable > default (`~/.agent-quorum` / `<home>/runs/loop-<name>`).
Structured `config`/`secrets` resolve in the override tier (override > env >
`<home>/config.json` > default); when a top-level scalar (`iters`/`quality`/`fix`/
`translate`/`locale`) and the same path in `config` are both set, the top-level
scalar wins. `home` relocates the whole artifact root (`runs/` + `state/`) without
mutating `process.env`.
`locale` is the typed counterpart of `--locale`; it defaults to `en`.
Clarification questions sent through Telegram target that locale. Non-English
locales also run the translate pass and write `plan.final.<locale>.md`; `en`
keeps the final plan English-only unless `translate` is explicitly enabled for
compatibility. The options are typed alternatives to mutating `process.env` — the
`workDir`/`config`/`secrets` plumbing itself never writes to the calling process
environment; ambient `AGENT_QUORUM_*` env still fills any unset key (see
[configuration.md](configuration.md)).

Every new run performs a read-only creator assessment before `plan.v0.md` and
writes schema-2 `readiness-contract.json`. It freezes source/system digests, the
implementation boundary, appetite, eight-domain applicability/risk, material
questions, operator-decision IDs, and the trusted catalog identity used for
semantic admission. With clarification unavailable, unresolved material
questions preserve a useful plan but force `unable-to-decide`. A positional
existing plan supplies the assessment boundary even though the original request
remains explicitly unavailable.

Role JSON first passes its structural schema, then closed-world semantic
admission verifies the exact plan version, candidate and lineage binding,
catalog, fixed domains, material issue identities, retained context, invariant
occurrences, and evidence grounding. Every critic, conditionally required fix
reviewer, and applicable Judge source reports each retained occurrence exactly
once as `satisfied`, `not-applicable`, `violated`, or `unresolved`. Grounded
`satisfied` and grounded `not-applicable` normalize to resolved; `violated` stays
negative, `unresolved` stays inconclusive, and disagreement between required
sources stays explicit. An ungrounded `not-applicable` rejects the whole role
artifact. A fix-review source is required only when reviewed replacement bytes
are retained; disabled, skipped, rejected, or restored paths record an explicit
exemption.

`convergence.vN.json` and `convergence.final.json` use schema version 3, while
`judge.final.meta.json` uses schema version 2. Earlier readiness artifact,
contract, and Judge-metadata schemas are unsupported. Resume requires a matching
current-schema `plan.vN.md`/`convergence.vN.json` pair and current frozen
contract; missing, malformed, or unsupported proof fails before stale artifacts
are archived. `opportunities.json` stores non-blocking improvement fingerprints
and first/last-seen versions. Those entries are reported by
API/summary/status but do not trigger a creator update or affect readiness.

Finalization settles one exact canonical candidate before constructing
`FinalProjection`. The canonical proof, deterministic system check, any required
fix review, and applicable final Judge evidence must bind those same bytes. A
late content mutation invalidates current evidence, and a downgrade to
`needs-review` is monotonic within that finalization pass; package and localized
outputs derive only from the settled candidate.

When a bot token and chat id resolve (from `secrets`/`config`, the
`<home>/secrets.json`+`config.json` store, or ambient env), `runPlanLoop` also
sends the same best-effort completion notification as the CLI. Notification
failures are logged and do not alter the returned `RunResult`.

## launchPlanLoop(options)

Detaches a run into its own process group with `run.log` redirection.

```ts
const { exitCode, output, workDir, pid, logPath } = await launchPlanLoop({
  input: 'task.md',
  resume: false,
});
// output: "started: task\n  pid:   …\n  log:   …\n  work:  …"
```

`workDir`/`pid`/`logPath` are the structured counterparts of the `output`
text. A detached launch cannot report `iterations`/`health` at detach time by
construction — once the run finishes, read the artifacts in `workDir`
(`summary.md`, `plan.final.md`). `workDir`/`config` are forwarded to the detached
child through its environment copy; a `secrets` (or ambient) bot token travels via
an owner-only `0600` handoff file under `<home>/handoff/` (path-only, with the
ambient token stripped from the child env), never as an env value. The parent
`process.env` is left untouched.

When Telegram credentials are present, completion notifications are sent by
the detached child run, not by the launch parent.

## getRunStatus(query?)

```ts
const all = getRunStatus(); // scriptable live-first/recent-finished listing
const one = getRunStatus(12345); // any PID in a run's process tree
```

Returns `{ exitCode, output }` with the rendered snapshot; exit 2 for an
unknown PID, 3 for a PID outside any agent-quorum tree. The signature and PID
behavior are unchanged; with no query, `output` is now the scriptable run
listing.

## addIntervention(workDir, message, target?)

```ts
const result = addIntervention('/path/to/loop-task', 'prefer the staged rollout', 'creator');
// result.output: "recorded intervention: …/operator-interventions.jsonl id=op-… target=creator"
```

`target` defaults to `'all'`; valid targets are `all | creator | critic |
fixer | reviewer` (the translator is deliberately exempt). `addIntervention`
keeps its `(workDir, message, target?)` signature.

## Selector lookups

```ts
const runs = listRuns(); // every run record across all known stores
const run = getRun('my-plan'); // by name, runId (or prefix), or { kind: 'last' }
const log = getRunLogPath('my-plan'); // run.log path, or undefined if none exists
interveneRun('my-plan', 'prefer the staged rollout', 'creator');
const pruned = pruneRuns({ keepCount: 50, maxAgeDays: 30, dryRun: true });
```

`listRuns`/`getRun`/`getRunLogPath`/`interveneRun`/`pruneRuns` are the library
counterparts of the `status`/`show`/`logs`/`intervene`/`prune` commands. A
selector is a string token (pid, runId or prefix, or name) or a structured
`RunSelector` (`{ kind: 'last' }`, `{ kind: 'work'; value }`); a pid resolves a
live run only. `getRun` returns a `RunRecord | undefined` (a bare `--work`
selector has no record); `interveneRun` resolves the selector to its workdir
then delegates to `addIntervention`, returning `{ exitCode: 2 }` when nothing
matches. `pruneRuns(policy?)` removes terminal records only (never workdirs).

Each lookup accepts a trailing `RunLookupOptions` (`{ home?; store? }`) so a run
created under a custom `home` is reachable without mutating `process.env`:

```ts
const run = getRun('my-plan', { home: '/tmp/sandbox' });
const scoped = listRuns({ store: '.agents/plans/.runs' }); // one ledger only
```

`listRuns` mirrors the CLI listing: by default it **aggregates** across all known
stores (the ambient `STATE_DIR`/`PLANS_DIR`-derived store, `<home>/state`, and the
project-local `<cwd>/.agents/plans/.runs`), deduped and read-only. `home` overrides
only the home root and still aggregates; `store` is the single-store scope. The
selector helpers `getRun`/`getRunLogPath`/`interveneRun` and `pruneRuns` stay
single-store-ambient (no cwd/project-local aggregation) and honor `store` only to
scope, while `home` keeps their existing ambient resolution.

## ExitCode

```ts
enum ExitCode {
  Ok = 0,
  Usage = 1,
  UnknownPid = 2,
  SchemaInvalid = 3,
  EmptyOutput = 4,
  RuleViolation = 5,
  Blocked = 6,
  ClarifyCancelled = 7,
  ClarifyTransportFailure = 8,
  SignalTeardown = 143,
}
```
