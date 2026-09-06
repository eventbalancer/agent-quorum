# Autonomous issue delivery in local Codex

This repository-local controller delivers one eligible issue at a time through
verified integration into `main`. Installing or implementing it does not activate
it, select existing issues, or authorize releases. The public `agent-quorum`
planning CLI and package exports retain their existing purpose.

## Prepare and authorize

Use Node 24 or later, the repository's pinned pnpm, the installed Codex CLI, and
GitHub CLI authentication for `eventbalancer/agent-quorum`. This implementation's
autonomous planning profiles support Codex. Ordinary interactive planning keeps
its provider matrix. Configure actual available model/reasoning combinations;
there is no automatic provider, model, subscription, or permission substitution.

The macOS host also needs a working `/usr/bin/cc` and its local SDK. Activation
compiles a frozen C canary outside the sandbox, then runs it under the same Codex
permission profile as workers. Compilation and the canary share a deadline of at
most 15 seconds, further limited by the current command and execution bounds.
The native program avoids interpreter launchers and libraries that can require
reads beyond the profile's minimal runtime paths. No extra filesystem grant is
added. Compiler failure blocks activation with
`native-confinement-compiler-unavailable`; cancellation and deadline errors retain
their existing behavior.

The canary must read candidate evidence and receive `EACCES` or `EPERM` for a
neighboring file, candidate writes, and an outbound connection. The neighboring
file has no extra deny rule. The connection attempt has a two-second bound;
missing files, connection refusal, and timeouts do not prove confinement.

Create a private JSON profile outside candidate worktrees. The following is an
example to edit, not an activation-ready configuration:

```json
{
  "worker": { "model": "YOUR_AVAILABLE_CODEX_MODEL", "reasoning": "high" },
  "reviewer": { "model": "YOUR_AVAILABLE_CODEX_MODEL", "reasoning": "high" },
  "planning": {
    "configFile": "/absolute/path/to/your/planning-config.json",
    "quality": "balanced",
    "maxIterations": 3,
    "maxRuns": 2
  },
  "bounds": {
    "providerStartsPerIssue": 96,
    "providerStartsPerDay": 288,
    "providerTimeoutMs": 300000,
    "providerRetries": 1,
    "providerRetryDelayMs": 1000,
    "commandTimeoutMs": 900000,
    "liveStartsPerScenario": 2,
    "liveScenarioTimeoutMs": 1200000
  },
  "scope": { "include": [], "exclude": [], "priorities": [] },
  "executor": {
    "kind": "docker",
    "image": "YOUR_LOCAL_IMAGE@sha256:REPLACE_WITH_64_HEXADECIMAL_DIGEST"
  }
}
```

An empty `include` means all otherwise eligible issues; `exclude` always wins.
`priorities` is an ordered list of issue numbers. No approval label is required.
Each numeric bound must be an explicit finite safe integer. The image must already
exist locally and contain supported Node, pinned pnpm, Python 3, an offline
dependency store, and the frozen toolchain described below. The controller never
pulls an image. The container has its own loopback, no host network or Docker
socket, no delivery credentials, and a read-only root. Writes are limited to the
owned candidate, private scratch space, caches, and scenario artifacts; live
scenarios mount the candidate read-only. Missing enforceable confinement blocks
activation. The macOS executor denies network access; the repository's network
fixture tests require the isolated container executor for affirmative activation.

Optionally add `project` with `id`, `statusFieldId`, `inProgressOptionId`,
`doneOptionId`, and `blockedOptionId`. With no mapping, GitHub Projects is unused.
An unavailable configured project leaves visible pending reconciliation.

```sh
pnpm run delivery -- prepare --profile /absolute/path/to/delivery.json
pnpm run delivery -- status
pnpm run delivery -- events
```

Preparation requires a clean source revision. It freezes controller code,
dependencies, role contracts, planning configuration, and enforcement policy
outside candidate worktrees. Inspect the reported mandate digest, scope,
operations, bounds, and blockers. State defaults to
`$HOME/.agent-quorum/delivery/eventbalancer-agent-quorum/`; an explicit
`--state-dir` is available for isolated inspection and rehearsals.

Only the following explicit operator instruction authorizes bounded positive
activation probes and, if they all pass, enables delivery:

```sh
pnpm run delivery -- activate --digest EXACT_PREPARED_DIGEST
```

Activation verifies SQLite/runtime support, exact frozen files, actor permissions,
required check identities and producer provenance, supported profiles, distinct
worker/reviewer invocations, confinement, finite starts, cancellation, and limit
enforcement. The effective Codex configuration, managed layers, and reported
CLI identity are attested. Inherited MCP servers are inventoried by name and
configuration digest, explicitly disabled, and checked for drift before provider
starts. Provider environments exclude delivery credentials and guardian control
files.
Private configuration, URLs, tokens, and raw provider output are not status data.

At each delivery stage, the controller privately reads the existing GitHub CLI
credential and verifies its account against the mandate. That credential is
fixed for the stage's GitHub requests and trusted Git operations, so a later
ambient account change cannot redirect an in-progress write. The token remains
in process memory and child environments for those trusted commands; it is never
written to the ledger, evidence, or status, or passed to workers and candidate
commands. Missing credentials or a different actor block delivery. No credential
is created or changed by this selection.

GitHub must enforce required checks and an up-to-date base for this actor without
an applicable bypass. Required producers must have immutable action references;
the active GitHub workflow/action tree is pinned. These conditions are checked
again at merge, for both base and candidate. Changing protections, the actor,
workflow producers, or the active controller requires operator action and fresh
authorization; the controller cannot repair its own permission boundary.

A missing prerequisite leaves a visible blocked state. Requirements approval,
a successful build, an existing login, an unknown auth result, and this document
are not positive activation evidence. Use the current preparation and activation
results to identify missing check provenance, enforcement, or immutable action
references. The operator must correct those prerequisites and reverify them;
an earlier inspection is not evidence about the current server configuration.

After successful activation, a macOS LaunchAgent supervises the guardian. No
Codex app heartbeat or new provider API subscription is required. The guardian
owns each controller step and its child process group. It checks group ownership
before command admission and during active work, stops observed reparented
helpers, and confirms cleanup before releasing ownership or acknowledging pause.
Restart reconciles owned processes and unfinished operations before dispatching
work. Host provider supervision covers owned process groups and observed
orphans; it does not establish kernel containment of a deliberately compromised
provider engine. The supported installed Codex engine/version and read-only
policy remain activation prerequisites. Candidate commands run within the
container's process namespace and lifetime boundary.

## Inspect and control

```sh
pnpm run delivery -- status
pnpm run delivery -- events --after 0
pnpm run delivery -- pause
pnpm run delivery -- stop
pnpm run delivery -- resume
pnpm run delivery -- revoke
```

Status reports mandate identity, stage, issue, worktree, PR, budgets, measured
activity, held reservations, blockers, pending effect identities and input
digests, API backoff, and evidence references. Raw effect inputs and outputs
remain private.
Events contain sanitized facts. Read notifications using the events command and
acknowledge delivered events using its `--acknowledge` sequence option. Repeating
an unchanged observation does not create another notification.

Pause prevents new dispatches immediately and acknowledges `paused` only after
owned work quiesces. Stop terminates owned work and retains recovery state.
Revocation prevents future dispatches. Resume uses the existing mandate and
counters, rechecks frozen policy, and reconciles actual state; it cannot activate
a previously unverified installation or revive revoked authority.

To narrow scope, supply a JSON object containing `include`, `exclude`, and
`priorities`. Expansion additionally requires the current digest:

```sh
pnpm run delivery -- scope --scope /absolute/path/to/scope.json
pnpm run delivery -- scope --scope /absolute/path/to/expanded-scope.json --authorize CURRENT_DIGEST
```

A scope restriction stops excluded work immediately. Reopening exhausted work
requires an explicit additional allowance; old counters remain visible:

```sh
pnpm run delivery -- reopen --issue 123 --active-minutes 20 --repairs 1 --authorize CURRENT_DIGEST
```

Optional `--provider-starts`, `--design-runs`, and `--live-starts` grant the named
attempt allowance. `--operation-id` makes a repeated allowance request idempotent;
omitting it identifies a new explicit request. Reopened work queues behind an
already active issue. An allowance never changes the daily time cap, required
checks, mandatory scenario assurance, release exclusions, or provider profile.

## Selection and stage outcomes

The controller reads current main/checks, paginated issues, relevant PRs,
dependencies, configured project state, foreign session ownership, and unfinished
effects. Operator ordering comes first, followed by correctness blockers,
delivery reliability, ready improvements, and issue age. Selection rationale is
persisted. Ambiguous ownership is ineligible; advisory worktree marker expiry
never proves that a session is safe to take over.

A missing checkout may retain its completion marker in Git's registered worktree
admin directory. The controller honors that existing marker only after verifying
the unique canonical path mapping, common repository, HEAD, and current commit.
Missing unfinished checkouts and inconsistent or aliased registrations remain
ambiguous; discovery never removes registrations or writes completion markers.

Refinement preserves original evidence and intended outcomes, actualizes stale
facts, and defines observable acceptance. Technical/product choices and breaking
contracts are recorded as mandate-authorized decisions. An obvious fix may skip
design planning. Otherwise an exact final plan needs strict current readiness
proof; exit code zero, `needs-review`, and artifact existence cannot admit it.
A decomposition retains the original issue and links independently deliverable
outcomes. Prior resolution, duplication, partial progress, blocking, and merged
implementation remain distinct outcomes.

Implementation uses a helper-created worktree from the verified `origin/main`
SHA. The frozen delivery role contracts are
`skills/delivery-worker/output.schema.json` and
`skills/delivery-reviewer/output.schema.json`. Read-only workers return complete
digest-bound edit batches; only the broker
writes. It rejects traversal, symlink escapes, generated-file edits, release
version changes, and changes to frozen workflow producers. Commands generate
build/package-manager outputs inside confinement. Candidate hooks and scripts
have neither delivery credentials nor controller-state access. A frozen hook
wrapper preserves `check` and restaging behavior; `--no-verify` is never used.

The sequence is implementation, bounded refactor, tidy, verification, independent
code review, bounded repair, commit, applicable live gate, PR checks, exact-head merge, main checks,
and backlog reconciliation. Formatter/linter/hook changes invalidate affected
receipts. Material findings need correction or evidenced dismissal and fresh
review. Changed main is incorporated with an ordinary merge into the owned
branch. The broker publishes only that branch, never force-pushes, never delays
via auto-merge, and never bypasses protections.

The worker completes the refactor and tidy passes within implementation before
returning ready. Refactor targets immediate structural and readability benefits
and may include justified related files for the same behavior-preserving change;
tidy emphasizes conventions and local clarity. Their responsibilities can
overlap. No worthwhile edits is a valid result, and neither pass adds an
unbounded polish loop, separate approval, or mandatory extra provider invocation.
The frozen worker contract and controller govern these passes; candidate skill
edits cannot replace the active contract. All activity consumes the existing issue
and daily allowances, and subsequent edits invalidate affected verification and
review evidence as usual.

A merge is first reported as verification pending. Completion requires the
observed merged revision/tree, successful required main checks, and reconciliation.
An unhealthy integrated base creates a shared incident and prevents unrelated
merges. A shared check failure is polled every minute using read-only requests
under the originating allowance. A failure before integration checks current
main; an integrated failure requires both the integrated revision and current
main to pass. Automatic continuation also requires unchanged authority and
current server enforcement;
policy or actor drift requires operator reconciliation. Local blockers permit
independent work. Completed worktrees are marked done and retained with their
private artifacts; destructive cleanup is manual.

## Findings and recovery

Necessary findings stay within acceptance. Adjacent work and blocking
prerequisites receive an evidence-backed update or a deduplicated linked issue.
Unverified observations remain observations. Authored issues, prompts, and
repository artifacts use English.

Every non-idempotent effect has a durable intent and unique identity. GitHub
creations include an operation marker; commits and owned branches have matching
identities. After an uncertain response, recovery inspects the actual outcome.
An empty search after a timeout does not permit another creation. Unresolved
outcomes stay pending. Partial edit batches reconcile before the next phase.

SQLite uses transactional state, full durability, and owner-only local files.
Evidence artifacts are separate, digest-bound files. Do not hand-edit the ledger,
receipts, frozen runtime, or counters. Do not delete state to reset exhaustion.
Unsupported ledger/schema versions, corrupt evidence, failed durable writes,
unknown process ownership, or clock discontinuities stop active work visibly.
Use status/events to identify the blocker, correct its external condition, then
resume an existing verified mandate or prepare and explicitly authorize a new
one when policy adoption is required. No automatic state migration admits old
proof as current.

## Time and verification

Active work is cumulative: 120 minutes per issue across days and restarts,
360 minutes per Europe/Moscow calendar day, and two corrective passes after
review, each including renewed independent review. Analysis, provider latency
and retries, planning, edits, verification, review, repairs, and backlog work
count. Passive CI waiting and waiting for future activation do not. Overlapping
activity counts elapsed time once. Shared maintenance consumes the day allowance;
issue work cannot be relabeled to evade its own cap.

The guardian reserves and checkpoints intervals, settles the preceding interval
before extending permission, splits accounting at Moscow midnight, and keeps
uncertain reservations held across recovery. Host downtime is not charged.
Measured time and retained reservations preserve fractional milliseconds. Child
deadlines and live-gate request allowances round the remaining time down to whole
milliseconds without refunding consumed time or increasing an allowance.
Every actual provider start, including nested recovery/validation retries, has
an admitted finite attempt and timeout. Exhaustion cannot select a different
profile or reduce assurance. Idle queues poll every five minutes; passive CI
polls every minute, subject to durable GitHub Retry-After and rate-limit reset
backoff. Waiting through that backoff consumes no active allowance, and an
uncertain mutation is reconciled before any retry.

Design readiness, implementation verification/review, and live verification are
separate evidence classes. Changes with no applicable live gate or recorded
material uncertainty run zero real plan-generation tests. Applicable planner,
provider, readiness, role, harness, or enforcement changes retain both mandatory
sentinels: standard `quick`, at most two iterations, and high-risk `balanced`,
at most three. The implementation revision is committed first, the manifest pin
is a separate commit, and outputs stay outside the repository. Successful
unaffected scenarios survive restart. Before launching, all remaining mandatory
scenarios must fit their enforced allowances; otherwise the unmet gate remains
visible and the issue is deferred.

The frozen `src/delivery/live-driver.ts` imports the candidate's public
`src/index.ts` API and drives each sentinel. A host-owned provider journal is
stored beside each writable attempt directory as
`attempt-N.provider-provenance.json`, outside the candidate's writable mount.
It binds the actual provider starts, role contracts, requests and responses to
the scenario input, tested revision, attempt, profile, configuration, and frozen
policy. Admission reconstructs critic, judge, and fix-reviewer decisions using
frozen semantic checks and matches the claimed proof to those occurrences.
Candidate-produced files alone cannot satisfy that provenance requirement.
Invalid provenance fails the affected sentinel; successful unaffected scenarios
remain reusable. Journals contain private source material and provider output,
and status exposes their references rather than their contents.

The original tested revision is immutable. Reuse after ordinary documentation
changes requires unchanged relevant input digests and separate applicability
review of the intervening diff. Instructional Markdown is an assessed input.
Candidate evidence decoders cannot redefine assurance: proposals under
`skills/evidence-decoder/descriptor.json` name only `decoder.mjs` and
`fixtures.json`, receive distinct independent review of exact code and fixture
bytes, and execute positive/adversarial conformance in a read-only sandbox.
Approved projections still pass the frozen readiness and sentinel assertions.
Descriptors bind the producer revision and frozen policy. Unsupported evidence
without such admission is deferred, never silently accepted as legacy proof.
An approved decoder may translate artifact JSON and provider output schemas;
it cannot change the observed calls, roles, prompts, schemas, raw digests, or
scenario context. Actual negative provider verdicts must remain negative.

Full release calibration is a manual release-owner obligation for the triggers
in [release.md](release.md). Autonomous delivery performs no release version
bump, release tag, publication, GitHub Release, publication approval, or release
workflow invocation. A release-only issue is explicitly deferred.

## Implementation verification contract

Use fake providers, deterministic GitHub transport, temporary Git repositories,
controlled clocks, and fault injection for the normal test suite. A rehearsal
must use isolated state and fake external effects; it must neither install a
LaunchAgent nor deliver a real backlog issue. An actual activation requires
separate explicit authorization and affirmative O-1 evidence.

Run the non-delivering CLI rehearsal with fake probes and GitHub effects:

```sh
pnpm exec vitest run tests/unit/delivery-activation.test.ts -t 'inactive operator rehearsal'
```

Run `pnpm run check`, `pnpm run test`, and `pnpm run test:coverage`, plus affected
workflow/Claude mirror and role-schema checks. The capability itself changes
provider control and readiness admission, so its own merge also needs the two
live sentinels after separately authorized implementation and manifest commits.
Deterministic tests are not evidence that those live scenarios ran. V8 coverage
measures TypeScript and JavaScript; the Linux Python watchdog is exercised through
separate confinement and process-lifetime probes.

| Requirements                              | Principal verification surfaces                                                                                                                                                                                 |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-1–FR-2, FR-19; AC-1–AC-2, AC-12, AC-15 | Controller sequencing, CLI/activation/guardian tests, frozen mandate and interactive mirrors                                                                                                                    |
| FR-3–FR-6; AC-3–AC-4, AC-16               | Intake/refinement, session ownership, strict plan admission, exact isolated base, decoder conformance                                                                                                           |
| FR-7–FR-9; AC-5, AC-11                    | Finding classification, deduplication, pending effects, distinct backlog outcomes and optional projects                                                                                                         |
| FR-10–FR-13; AC-6–AC-8                    | Review/current-tree receipts, GitHub check provenance, resumable exact sentinel gate, zero calibration dispatch                                                                                                 |
| FR-14–FR-18; AC-9–AC-11                   | Ledger budgets, guardian deadlines, nested attempts, PID/start identity, interruption recovery, integrated main                                                                                                 |
| FR-20–FR-22; AC-13–AC-15                  | Quiet idle events, control documentation, release exclusions and inactive rehearsal                                                                                                                             |
| NFR-1–NFR-9                               | Sequential ownership; replay uniqueness; merge rejection; live-run counts; persistent accounting; confinement; incompatible evidence rejection; private summaries/English artifacts; notification deduplication |

## Container image and frozen verification toolchain

The optional Docker executor requires an operator-prepared, locally available
image addressed by its complete `repository@sha256:...` digest. Delivery never
builds, pulls, or publishes that image. The fixed repository profile requires
Linux, Node.js 24 or newer, the exact `packageManager` version from the frozen
`package.json`, and Python 3 with Linux `prctl` support. Python runs as namespace
PID 1 with dumpability disabled; candidate processes cannot reopen the owner's
heartbeat input. The container drops all capabilities, denies privilege gains,
has a read-only root filesystem, and has its own network namespace with no
external interface.

The owner renews command heartbeats every 100 ms with a lease of at most 400 ms,
capped by the command deadline. The shorter lease leaves room for small host/VM
clock differences below both supervisors' 500 ms acceptance ceiling.
Expired or excessive heartbeats still stop admitted commands, and a late renewal
cannot cancel termination after lease expiry.

Prepare `/aq-toolchain` in the image from the exact source snapshot used by
`delivery prepare`. It must contain byte-identical `package.json`,
`pnpm-lock.yaml`, and every present file in `VERIFICATION_POLICY_FILES` from
`src/delivery/gate-toolchain.ts`. Files absent from that snapshot must also be
absent from the toolchain. Install its Linux dependencies ahead of activation.
The TypeScript, ESLint, Prettier, Vitest, and tsx entrypoints and their dependency
links must resolve entirely inside `/aq-toolchain`; do not link them to the
operator's host installation. The image must also provide an offline pnpm cache
that works with the executor's private `HOME` and writable candidate and `/tmp`
directories. Unknown product dependencies remain blocked until an authorized
image/cache supplies them. No package lifecycle scripts run during delivery
installation or lockfile refresh.

Activation compares the image's package, lockfile, and configuration bytes with
the frozen mandate snapshot. It tests the offline dependency installation,
frozen tsx loader, private fixture loopback, forbidden host access, read-only
harness and toolchain, and protected supervisor input. It also plants a poisoned
candidate Vitest package and requires the frozen runner to reject a failing
assertion and accept a valid one. An absent or incompatible toolchain visibly
blocks activation.

Verification launches absolute entrypoints from `/aq-toolchain`; candidate
`node_modules/.bin` and package scripts do not select gate implementations.
TypeScript, ESLint, and Vitest receive configurations derived from the frozen
files with explicit candidate source roots and private per-command caches.
Prettier receives the frozen configuration and ignore file. The source loader
and Vitest assertion imports resolve through the frozen toolchain. Product
source, tests, and product dependencies remain candidate inputs. The frozen live
driver uses the same frozen tsx entrypoint inside its container, and provider
requests cross only the bounded data broker. The macOS sandbox fallback uses
the frozen runtime's own toolchain; the repository's loopback fixture gate
still requires a passing container prerequisite before activation.
