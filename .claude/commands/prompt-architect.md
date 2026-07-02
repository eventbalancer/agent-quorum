---
name: prompt-architect
description: Compose problem-first XML prompts and agent-quorum self-planning run profiles from requests, issues, requirements, or saved plans, then launch only after operator confirmation.
---

# prompt-architect

Transform a brief or vague request into a problem-describing prompt for a
downstream coding agent. The prompt hands the agent what is known about the
problem and lets it choose the solution shape. For this repository, the primary
downstream runner is the local `agent-quorum` self-planning loop, started
detached through `pnpm run run:cli -- launch` (the `agent-quorum` bin, run
from source) so the run outlives the Claude Code session that confirmed it.

This is the only command in the chain that may start `agent-quorum`, and it does
so only after explicit operator confirmation.

Follow the repository-root `AGENTS.md` / `CLAUDE.md` operating rules and
`docs/development/conventions.md`.

## Arguments

`$ARGUMENTS` is optional.

```text
/prompt-architect <request>
/prompt-architect <issue-url> [instructions]
/prompt-architect <requirements-path> [instructions]
/prompt-architect <plan-path> [instructions]
/prompt-architect
```

Accepted path forms:

- `<repo>/.agents/requirements/<name>.md`
- `<repo>/.agents/plans/<name>.md`
- `.agents/requirements/<name>.md`
- `.agents/plans/<name>.md`
- `/requirements/<name>.md`
- `/plans/<name>.md`

Empty `$ARGUMENTS` means catalog mode: ask one question in the operator's
conversation language for what to analyze or compose.

## Philosophy

The prompt describes the problem, not the solution. It loads the downstream
agent with verified context — symptoms, prior attempts, constraints, relevant
docs — and specifies the result contract. It avoids step-by-step reasoning
scaffolding, verbosity controls, and self-critique boilerplate; reasoning depth
is controlled by the `agent-quorum` quality setting.

## Modes

- **Free-text**: default; infer pattern from request.
- **Issue mode**: a GitHub issue URL is detected; fetch issue content with
  `gh issue view` when available.
- **Requirements mode**: first token resolves to a saved requirements document;
  downstream agent reads that document in full.
- **Plan mode**: first token resolves to a saved plan file; downstream agent
  reads that plan in full and implements or refines according to instructions.

## Pattern Registry

Patterns inform persona, useful context, and result contract. They do not impose
analysis steps.

| #   | Pattern                 | Triggers                                                      | Role                                               |
| --- | ----------------------- | ------------------------------------------------------------- | -------------------------------------------------- |
| 1   | Architecture Audit      | architecture, audit, design review                            | Staff systems architect                            |
| 2   | Code Review             | review, PR review, check code                                 | Principal engineer, production readiness           |
| 3   | Security Analysis       | security, vulnerabilities, secrets                            | AppSec engineer                                    |
| 4   | Configuration & Tooling | config, settings, tooling, DX, lint, CI                       | Staff DevTools engineer                            |
| 5   | Performance             | performance, latency, bottleneck, profiling                   | Performance engineering lead                       |
| 6   | Schema & Contracts      | schema, JSON schema, API contract, package exports, CLI flags | API/schema contract engineer                       |
| 7   | API Design              | public API, library API, integration, TypeScript consumer     | API design lead                                    |
| 8   | Debugging & Root Cause  | debug, bug, error, crash, fix, not working                    | Senior debugging specialist                        |
| 9   | Refactoring             | refactor, migrate, tech debt, rewrite                         | Staff engineer, incremental evolution              |
| 10  | Release & Packaging     | release, npm, package, dist, build, publish                   | Release engineering lead                           |
| 11  | Plan Implementation     | plan path                                                     | Senior implementation engineer executing a plan    |
| 12  | Requirements Execution  | requirements path                                             | Senior engineer implementing approved requirements |

## Instructions

### Step 0 — Route by arguments

**Empty arguments**: ask what to compose, then re-enter Step 0.

**Priority 0: requirements/plan path detection.**

If the first token matches an accepted requirements path, set
`REQUIREMENTS_MODE=true`, resolve `REQUIREMENTS_PATH`, strip the token, and run
Step 0.5.

If the first token matches an accepted plan path, set `PLAN_MODE=true`, resolve
`PLAN_PATH`, strip the token, and run Step 0.6.

**Priority 1: GitHub issue URL detection.**

Detect `https://github.com/<org>/<repo>/issues/<N>`. If matched, set
`ISSUE_MODE=true`, fetch the issue with:

```sh
gh issue view <N> --repo <org>/<repo> --json number,title,body,state,labels,updatedAt,comments,url
```

If `gh` is unavailable or the issue cannot be fetched, carry the URL as
unverified context and surface the gap. Record `<org/repo#n>` as the originating
issue reference for downstream delivery.

**Priority 2: free-text.**

Use the remaining arguments as the request.

### Step 0.05 — Mark originating issue in progress

Run this step as soon as an originating GitHub issue is known: immediately after
issue-mode detection, or after requirements/plan metadata reveals an `Issue:`
reference. Do it before repository context gathering, actuality checks,
composing prompt content, or launching `agent-quorum`.

Use GitHub through `gh`: discover the repository's linked ProjectV2 board with
`gh api graphql`, add the issue item if it is absent, resolve the `Status`
single-select field and the `In Progress` option with `gh project field-list`,
then set the item with `gh project item-edit`. If several linked projects exist,
ask the operator which board to use before continuing. If `gh`, the linked
board, `Status`, or `In Progress` is unavailable, stop and report the blocker
instead of continuing to work the issue without the board transition.

### Step 0.1 — Gather repository context

This command runs inside `agent-quorum`; there is no repo resolver. Gather
compact context only when it helps the matched pattern:

1. `package.json`: name, version, scripts, exports, bin, engines,
   dependencies.
2. `CLAUDE.md`: operating rules, especially public API and self-planning.
3. `docs/architecture.md`, `docs/api.md`, `docs/cli.md`,
   `docs/configuration.md`: only the relevant sections.
4. `config.example.json`: default runner/model/role matrix if orchestration behavior
   is in scope.
5. `skills/**/SKILL.md` and `skills/**/*.schema.json`: when role I/O or prompt
   contracts are in scope.
6. `src/` top-level structure for architecture/refactor/config patterns.

Keep context compact. The downstream agent can read files itself.

### Step 0.2 — Preflight actuality check

Cheaply verify concrete claims:

- file/dir paths exist;
- docs referenced by the request exist;
- exported names exist in `src/index.ts` or `dist/index.d.ts` when relevant;
- CLI flags appear in `docs/cli.md` or `src/cli/*`;
- config keys appear in `docs/configuration.md` or `src/core/config.ts`.

Emit an `ACTUALITY` block only for stale or unverified claims. If everything
checks out, omit it.

### Step 0.3 — Detect output language

Default to the language of the user's request. For issue/requirements/plan
modes, use the language of extra delivery instructions; if none exist, default
to English for artifacts. XML tag names remain English.

### Step 0.5 — Read requirements metadata

Only for `REQUIREMENTS_MODE`.

Read `REQUIREMENTS_PATH` for validation and metadata. The downstream prompt must
tell the agent to read this file in full before any work. Embed only:

- title;
- status;
- 1-3 sentence summary;
- referenced files;
- unresolved Open items, if any;
- the originating issue reference (the `Issue:` field), if present.

Do not paste the full requirements body into the prompt.

### Step 0.6 — Read plan metadata

Only for `PLAN_MODE`.

Read `PLAN_PATH` for validation and metadata. The downstream prompt must tell
the agent to read this file in full before any work. Embed only:

- title;
- 1-3 sentence summary;
- referenced files;
- stale-path actuality warnings.

Do not paste the full plan body into the prompt.

### Step 1 — Analyze the request

Extract:

- intent: analysis, generation, review, planning, debugging, implementation;
- domain: architecture, CLI/API, config, provider/runtime, schema, docs,
  release;
- known facts, prior attempts, hypotheses;
- unknowns the responder must resolve;
- closest Pattern Registry match;
- useful iteration budget for Quick/Balanced/Thorough profiles.

If too vague to determine a domain, return to catalog mode.

### Step 2 — Compose the prompt

Typical length: 400-700 tokens; up to 1200 for deep audits. Plan or
requirements implementation prompts should stay around 200-500 tokens because
the downstream agent reads the source document itself.

Use XML-tagged blocks:

```xml
<role>
  One-line expert persona: domain + scope.
</role>

<problem_statement>
  Prose paragraphs. Describe the requested change, observed symptoms,
  hypotheses labeled as hypotheses, and open questions.
</problem_statement>

<known_context>
  <issue_context>...</issue_context>
  <requirements_context>...</requirements_context>
  <plan_context>...</plan_context>
  <actuality>...</actuality>
  <artifacts>...</artifacts>
</known_context>

<goals>
  3-5 bullets. Outcome/result contract, not implementation steps.
</goals>

<constraints>
  Domain guardrails plus mandatory defaults.
</constraints>
```

Omit empty sub-tags. Tag names stay English; block content uses `OUTPUT_LANG`.
File paths, identifiers, commands, and verbatim quotes stay as-is.

When an originating issue is known (issue mode, or the requirements `Issue:`
field), record it in `<known_context>` and note that the eventual commit or PR
must link it with `Closes #<n>` when the change fully resolves the issue, or
`Refs #<n>` when it does not. The downstream agent designs the change; delivery
links the issue at `/ship` time.

Phrasing:

- Use positive imperatives over prohibitions.
- Use calm plain prose; no ALL-CAPS emphasis.
- State scope explicitly: "every CLI entry point", "all public exports", etc.
- Do not include chain-of-thought scaffolding or status-update instructions.

Mandatory `<constraints>` defaults:

1. **Systemic and scoped**: address the root cause fully while changing only
   what the task requires. Avoid workarounds, speculative abstractions, and
   unrelated refactors.
2. **Grounded claims**: every code claim carries `file:line`; every behavior
   claim carries a log/test/doc/operator source. Label unsupported material as
   hypothesis.

Conditional defaults:

- **Skepticism of premise** when issue/requirements/plan mode or actuality
  anomalies exist: surface contradictions or gaps instead of guessing.
- **Requirements fidelity** in requirements mode: read the requirements document
  in full before work and preserve approved scope.
- **Plan fidelity** in plan mode: read the plan in full before work; surface
  divergences from live code instead of improvising replacements.
- **Public contract care** when touching `src/index.ts`, `package.json`
  `exports`, CLI flags, config keys, `config.example.json`, or `skills/**/*.schema.json`.

Constraint budget: at most 6 bullets total.

### Step 3 — Quality check

- Prompt is problem-centered, not process-centered.
- `<goals>` define concrete result shapes.
- Facts are verified or flagged in `<actuality>`.
- XML is well-formed.
- `<constraints>` includes mandatory defaults and at most 6 bullets.
- Prompt does not prescribe edits or future entity names.
- Requirements/plan bodies are not embedded.

### Step 4 — Save, output, and confirm launch

Save to `.agents/prompts/<slug>.md` under the repository root, never
overwriting existing files. The file contains this shape:

    # <Human-readable title>

    - Issue: <org/repo#n or none>

    ~~~xml
    <the generated prompt XML>
    ~~~

Record the originating issue reference in the saved prompt header so the plan
and delivery can link it. Create the directory if missing. On collision append
`-2`, `-3`, etc.

After saving, output in the operator's conversation language:

1. `Saved to <absolute path>`.
2. `Run profiles (quality -> speed):`.
3. A Markdown table: `Profile | Speed | Quality | Iters | Use when`.
4. One labeled `sh` fenced block per profile, ordered Thorough, Balanced, Quick.
   Each block contains exactly one single-line command.
5. A structured confirmation question when available, otherwise a plain question
   in the operator's conversation language, with choices: launch Thorough, launch
   Balanced, launch Quick, or do not launch.

Resolve paths for conversation output:

- prompt path: absolute under `<repo>/.agents/prompts/`;
- repo path: absolute path to this repository;
- workdirs: absolute paths under `<repo>/.agents/plans/loop-<slug>-<quality>`.

Before commands, choose iteration caps:

- narrow, well-bounded tasks: Quick 2, Balanced 3, Thorough 5;
- standard repo-local design/debug/review tasks: Quick 3, Balanced 5, Thorough 8;
- public API, schema, provider/runtime, security, packaging, or high-risk
  architecture tasks: Quick 5, Balanced 8, Thorough 12.

Command template:

```sh
cd <repo-absolute-path> && AGENT_QUORUM_WORK_DIR=<workdir-absolute-path> pnpm run run:cli -- launch --quality <quality> --iters <n> --prompt <prompt-absolute-path>
```

Keep commands identical except `--quality`, `--iters`, and workdir suffix.

`run:cli -- launch` detaches the run into its own process group and returns
immediately, so the run survives the Claude Code session closing. No manual
detach command is required.

Do not print the generated XML to the user. The saved prompt plus confirmation
offer is the deliverable. Start the selected command only after explicit
operator confirmation. On a confirmed launch, relay the command's `started:`
block to the operator — the run log path plus the follow (`tail -F`) and stop
(`kill -TERM -<pgid>`) commands — so they can observe and control the run after
the session closes. If the operator declines, report the saved prompt path and
stop.

## Edge cases

- **No request**: ask for one.
- **GitHub issue unavailable**: carry URL as unverified, include skepticism of
  premise.
- **Requirements not approved**: surface status and ask whether to continue.
- **Plan path missing**: stop and report accepted path forms.
- **Request already includes a solution**: translate it into outcome goals and
  constraints where possible; do not force the downstream agent to implement the
  proposed approach unless the operator explicitly requires it.
- **Potential breaking change**: include public contract care and ask for
  requirements approval when scope is unclear.

## Example output

````text
Saved to `/Users/<you>/agent-quorum/.agents/prompts/api-consumer-example.md`

Run profiles (quality -> speed):

| Profile | Speed | Quality | Iters | Use when |
|---|---:|---:|---:|---|
| Thorough | Slowest | Highest | 8 | Final planning run when completeness matters more than speed. |
| Balanced | Medium | Highest | 5 | High-quality everyday planning run. |
| Quick | Fastest practical | Medium | 3 | Quick idea check. |

Thorough:

```sh
cd /Users/<you>/agent-quorum && AGENT_QUORUM_WORK_DIR=/Users/<you>/agent-quorum/.agents/plans/loop-api-consumer-example-thorough pnpm run run:cli -- launch --quality thorough --iters 8 --prompt /Users/<you>/agent-quorum/.agents/prompts/api-consumer-example.md
```

Launch `agent-quorum` now?

- Thorough: most complete run.
- Balanced: high-quality everyday run.
- Quick: fast run.
- Do not launch: save the prompt without launching.
````
