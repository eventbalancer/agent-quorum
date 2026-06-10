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

## runPlanLoop(options)

Runs the core loop to completion in-process.

```ts
const { exitCode } = await runPlanLoop({
  input: 'my-plan.md', // plan file, or prompt file with prompt: true
  prompt: false,
  iters: 3,
  effort: 'high', // 'low' | 'high' | 'max'
  fix: true,
  translate: false,
});
```

`exitCode` follows the CLI contract (`ExitCode.Ok`, `ExitCode.SchemaInvalid`,
`ExitCode.Blocked`, …). Artifacts land in the resolved workdir
(`PLAN_LOOP_WORK_DIR` or `<plans>/loop-<base>`).

## launchPlanLoop(options)

Detaches a run into its own process group with `run.log` redirection.

```ts
const { exitCode, output } = await launchPlanLoop({ input: 'task.md', resume: false });
// output: "started: task\n  pid:   …\n  log:   …\n  work:  …"
```

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
