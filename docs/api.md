# API

```ts
import {
  runPlanLoop,
  launchPlanLoop,
  getRunStatus,
  addIntervention,
  ExitCode,
  type RunPlanLoopOptions,
  type LaunchPlanLoopOptions,
  type RunResult,
  type RunHealth,
  type LaunchResult,
  type CommandResult,
  type InterventionTarget,
  type Role,
  type Runner,
  type Effort,
} from 'agent-quorum';
```

The API is a thin, semver-deliberate surface over the same engine the CLI
uses. Functions return results; only the CLI calls `process.exit`. Operational
logging still goes to stderr.

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
  effort: 'high', // 'low' | 'high' | 'max'
  fix: true,
  locale: 'ru', // optional; localizes Telegram interaction + final companion plan
  translate: false, // optional compatibility toggle
  workDir: '/abs/path/loop-my-plan', // optional; takes precedence over PLAN_LOOP_WORK_DIR
  configFile: '/abs/path/plan-loop.json', // optional; takes precedence over PLAN_LOOP_CONFIG_FILE
});
// result: {
//   exitCode: 0,
//   workDir: '/abs/path/loop-my-plan',
//   finalPlanPath: '/abs/path/loop-my-plan/plan.final.md',
//   summaryPath: '/abs/path/loop-my-plan/summary.md',
//   iterations: 2,
//   health: { critic: 3, addressed: 2, new: 1, invalid: 0, validAddressedPct: 66 },
// }
```

`exitCode` follows the CLI contract (`ExitCode.Ok`, `ExitCode.SchemaInvalid`,
`ExitCode.Blocked`, …). The structured fields are built from the same data
that renders `summary.md`: `health` carries exactly the numbers of the
`final_health` line, `iterations`/`finalPlanPath`/`summaryPath` mirror their
summary lines; path fields are present only when the file exists, and failure
exits may carry `workDir` alone. Artifacts land in the resolved workdir; for
both `workDir` and `configFile` the precedence is option > environment
variable > default (`<plans>/loop-<base>` / the packaged `plan-loop.json`).
`locale` is the typed counterpart of `--locale`; it defaults to `en`.
Clarification questions sent through Telegram target that locale. Non-English
locales also run the translate pass and write `plan.final.<locale>.md`; `en`
keeps the final plan English-only unless `translate` is explicitly enabled for
compatibility. The options are typed alternatives to mutating `process.env` — the
`workDir`/`configFile` plumbing itself never writes to the calling process
environment. (The package-root `.env` loader keeps its reference semantics
and still fills missing keys; see
[configuration.md](configuration.md).)

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
(`summary.md`, `plan.final.md`). `workDir`/`configFile` options are forwarded
to the detached child through its environment copy; the parent `process.env`
is left untouched.

## getRunStatus(query?)

```ts
const all = getRunStatus(); // list every running plan-loop run
const one = getRunStatus(12345); // any PID in a run's process tree
```

Returns `{ exitCode, output }` with the rendered snapshot; exit 2 for an
unknown PID, 3 for a PID outside any plan-loop tree.

## addIntervention(workDir, message, target?)

```ts
const result = addIntervention('/path/to/loop-task', 'prefer the staged rollout', 'creator');
// result.output: "recorded intervention: …/operator-interventions.jsonl id=op-… target=creator"
```

`target` defaults to `'all'`; valid targets are `all | critic | creator |
fixer | reviewer` (the translator is deliberately exempt).

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
  SignalTeardown = 143,
}
```
