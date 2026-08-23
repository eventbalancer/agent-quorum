import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli } from '../helpers/cli.js';
import { pgidOf } from '../../src/runtime/proc.js';
import {
  createReadinessProofCatalog,
  createReadinessProofState,
  recordContextDelivery,
  replaceOccurrenceCoverageSnapshot,
} from '../../src/core/readiness-proof.js';
import { writeReadinessProofState } from '../../src/core/readiness-store.js';
import { fileSha256 } from '../../src/core/digest.js';
import { finalizeRunRecord, readRunRecords } from '../../src/core/run-store.js';
import {
  emptyCritique,
  writeStoreConfig,
  writeFakeBin,
  writeStructuredPlanFile,
} from '../helpers/harness.js';
import { finalProjection } from '../helpers/final-projection.js';

let tmp: string;
let fake: string;
const launchedPids: number[] = [];
const RUN_INPUT_BODY_SENTINEL = 'RUN_INPUT_BODY_MUST_NOT_REACH_LOG_8c2f31';

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// A codex stand-in that hangs: it records its own pid and a grandchild pid so
// status can be queried from the bottom of the tree.
function writeSlowCodex(): void {
  writeFileSync(
    path.join(fake, 'codex'),
    '#!/usr/bin/env bash\n' +
      'if [[ "${1:-}" == "login" && "${2:-}" == "status" ]]; then exit 0; fi\n' +
      'if [[ -n "${SLOW_CODEX_PID_FILE:-}" ]]; then echo $$ > "$SLOW_CODEX_PID_FILE.$$"; fi\n' +
      'sleep 300 &\n' +
      'if [[ -n "${SLOW_CODEX_PID_FILE:-}" ]]; then echo $! > "$SLOW_CODEX_PID_FILE.$$.child"; fi\n' +
      'wait\n',
  );
  chmodSync(path.join(fake, 'codex'), 0o755);
}

interface LaunchedRun {
  pid: number;
  work: string;
  log: string;
  grandchildPid: number;
  codexPid: number;
}

function statusIssue(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    addresses: null,
    severity: 'major',
    category: 'testability',
    claim: `${id} claim`,
    evidence: '',
    evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
    suggested_fix: 'fix',
    confidence: 1,
    duplicate_of: null,
    ...overrides,
  };
}

function writeStatusCritique(file: string, version: number, issues: unknown[]): void {
  writeFileSync(
    file,
    `${JSON.stringify({ plan_version: version, summary: `v${version}`, issues }, null, 2)}\n`,
  );
}

async function launchHangingRun(
  name: string,
  envOverrides: Record<string, string | undefined> = {},
): Promise<LaunchedRun> {
  const input = path.join(tmp, `${name}.md`);
  writeStructuredPlanFile(input, `Run ${name}`);
  appendFileSync(input, `\n${RUN_INPUT_BODY_SENTINEL}\n`);
  const pidBase = path.join(tmp, `${name}.codex.pid`);
  const result = runCli(
    ['launch', '--quality', 'quick', '--iters', '1', input, '--no-fix', '--no-translate'],
    {
      PATH: `${fake}:${process.env.PATH ?? ''}`,
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_CLARIFY: '0',
      AGENT_QUORUM_RETRY_COUNT: '0',
      AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0.3',
      AGENT_QUORUM_WORK_DIR: undefined,
      SLOW_CODEX_PID_FILE: pidBase,
      FAKE_CODEX_PROMPT: path.join(tmp, `${name}.codex.prompt`),
      ...envOverrides,
    },
  );
  expect(result.status).toBe(0);
  const pid = Number(/pid:\s+([0-9]+)/.exec(result.stdout)?.[1]);
  const work = /work:\s+(.*)/.exec(result.stdout)?.[1] ?? '';
  const log = /log:\s+(.*)/.exec(result.stdout)?.[1] ?? '';
  expect(Number.isInteger(pid)).toBe(true);
  launchedPids.push(pid);

  let codexPid = 0;
  let grandchildPid = 0;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const pidFiles = (await import('node:fs'))
      .readdirSync(tmp)
      .filter((entry) => entry.startsWith(`${name}.codex.pid.`) && entry.endsWith('.child'));
    const first = pidFiles[0];
    if (first !== undefined) {
      grandchildPid = Number(readFileSync(path.join(tmp, first), 'utf8').trim());
      codexPid = Number(first.replace(`${name}.codex.pid.`, '').replace('.child', ''));
      break;
    }
    await sleep(100);
  }
  expect(grandchildPid).toBeGreaterThan(0);
  return { pid, work, log, grandchildPid, codexPid };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-statustest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  writeSlowCodex();
  mkdirSync(path.join(tmp, 'plans'), { recursive: true });
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  writeStoreConfig(path.join(tmp, 'home'));
});

afterEach(async () => {
  for (const pid of launchedPids.splice(0)) {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
  await sleep(100);
  rmSync(tmp, { recursive: true, force: true });
});

describe('launch + status', () => {
  it('keeps provider parser details out of a detached run log', async () => {
    writeFakeBin(fake);
    const secret = 'DETACHED_PROVIDER_PARSE_SECRET_9a6d2e';
    const input = path.join(tmp, 'private-error.md');
    const malformed = path.join(tmp, 'malformed-critique.json');
    writeStructuredPlanFile(input, 'Detached privacy boundary');
    emptyCritique(malformed);
    const critique = JSON.parse(readFileSync(malformed, 'utf8')) as {
      review: { invariant_assessments: unknown[] };
    };
    critique.review.invariant_assessments = [
      {
        invariant_id: secret,
        complete: true,
        occurrences: [{ occurrence_id: 'O-secret', disposition: 'unresolved', evidence_refs: [] }],
      },
    ];
    writeFileSync(malformed, `${JSON.stringify(critique)}\n`);
    const result = runCli(
      ['launch', '--quality', 'quick', '--iters', '1', input, '--no-fix', '--no-translate'],
      {
        PATH: `${fake}:${process.env.PATH ?? ''}`,
        AGENT_QUORUM_HOME: path.join(tmp, 'home'),
        AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
        AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
        AGENT_QUORUM_CLARIFY: '0',
        AGENT_QUORUM_RETRY_COUNT: '0',
        AGENT_QUORUM_LAUNCH_VERIFY_DELAY: '0.1',
        AGENT_QUORUM_WORK_DIR: undefined,
        FAKE_CODEX_PROMPT: path.join(tmp, 'private-error.codex.prompt'),
        FAKE_CODEX_OUTPUT: malformed,
        FAKE_CODEX_SILENT_SECONDS: '1',
      },
    );
    expect(result.status).toBe(0);
    const pid = Number(/pid:\s+([0-9]+)/.exec(result.stdout)?.[1]);
    const log = /log:\s+(.*)/.exec(result.stdout)?.[1] ?? '';
    expect(Number.isInteger(pid)).toBe(true);
    launchedPids.push(pid);

    let content = '';
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(log)) {
        content = readFileSync(log, 'utf8');
        if (content.includes('code=unexpected-error')) {
          break;
        }
      }
      await sleep(100);
    }

    expect(content).toContain('agent-quorum: failed (code=unexpected-error)');
    expect(content).not.toContain(secret);
  }, 30_000);

  it('resolves a grandchild PID to the root run, lists runs, and tears down without orphans', async () => {
    const runA = await launchHangingRun('alpha');
    expect(existsSync(runA.log)).toBe(true);
    expect(runA.work).toBe(path.join(tmp, 'plans', 'loop-alpha'));

    const logContent = readFileSync(runA.log, 'utf8');
    expect(logContent).toContain('[agent-quorum]');
    expect(logContent).not.toContain('\x1b[');

    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    const byGrandchild = runCli(['status', String(runA.grandchildPid)], statusEnv, undefined, tmp);
    expect(byGrandchild.status).toBe(0);
    expect(byGrandchild.stdout).toContain('━━ alpha ━━');
    expect(byGrandchild.stdout).toContain(`PID=${runA.pid}`);
    expect(byGrandchild.stdout).toContain(`WORK: ${realpathSync(runA.work)}`);

    const nonAgentQuorum = runCli(['status', String(process.pid)], statusEnv, undefined, tmp);
    expect(nonAgentQuorum.status).toBe(3);
    expect(nonAgentQuorum.stderr).toContain(
      `PID ${process.pid} is not part of an agent-quorum tree`,
    );

    const runB = await launchHangingRun('beta');

    // A stale registry entry whose pid now belongs to a non-agent-quorum process
    // (this vitest worker) must be ignored by the no-argument discovery.
    writeFileSync(
      path.join(tmp, 'state', `${process.pid}.tsv`),
      `pid\t${process.pid}\nwork_dir\t${path.join(tmp, 'plans', 'loop-decoy')}\n`,
    );

    const listAll = runCli(['status'], statusEnv, undefined, tmp);
    expect(listAll.status).toBe(0);
    expect(listAll.stdout).toContain('found 2 agent-quorum run(s)');
    expect(listAll.stdout).toContain('alpha  [running]');
    expect(listAll.stdout).toContain('beta  [running]');
    expect(listAll.stdout).not.toContain('loop-decoy');

    // A stale `running` record whose pid is alive (this worker) with a matching
    // pgid but a different start token must be rejected, not listed as live.
    writeFileSync(
      path.join(tmp, 'state', 'runs', 'rdecoy00000-token.json'),
      `${JSON.stringify({
        runId: 'rdecoy00000-token',
        name: 'tokendecoy',
        pid: process.pid,
        pgid: pgidOf(process.pid) ?? '0',
        procStartToken: 'STALE-START-TOKEN',
        mode: 'plan',
        inputPath: path.join(tmp, 'decoy.md'),
        workDir: path.join(tmp, 'plans', 'loop-tokendecoy'),
        logPath: path.join(tmp, 'plans', 'loop-tokendecoy', 'run.log'),
        plansDir: path.join(tmp, 'plans'),
        startedAt: '2026-01-01T00:00:00Z',
        quality: 'quick',
        state: 'running',
      })}\n`,
    );
    const afterDecoy = runCli(['status'], statusEnv, undefined, tmp);
    expect(afterDecoy.status).toBe(0);
    // Unsupported pre-schema records are skipped without being rewritten.
    expect(afterDecoy.stdout).toContain('alpha  [running]');
    expect(afterDecoy.stdout).toContain('beta  [running]');
    expect(afterDecoy.stdout).not.toContain('tokendecoy');

    process.kill(runA.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(runA.pid)).toBe(false);
    expect(isAlive(runA.codexPid)).toBe(false);
    expect(isAlive(runA.grandchildPid)).toBe(false);

    process.kill(runB.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(runB.grandchildPid)).toBe(false);
  }, 120_000);
});

describe('status provider-neutral hints', () => {
  it('derives the stall hint provider and shows a provider-neutral retry hint', async () => {
    const run = await launchHangingRun('gamma');
    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    // The neutralized P1 retry trace token triggers the provider-neutral hint.
    appendFileSync(run.log, '    api retry 2/10 after 1172ms\n');
    const retry = runCli(['status', String(run.grandchildPid)], statusEnv, undefined, tmp);
    expect(retry.status).toBe(0);
    expect(retry.stdout).toContain('(a provider is retrying API calls, waiting not progressing)');
    expect(retry.stdout).not.toContain('claude is retrying');

    // A cursor stall names cursor in the hint, not the old hardcoded claude.
    appendFileSync(run.log, '[agent-quorum] cursor stream stalled: no byte progress\n');
    const stall = runCli(['status', String(run.grandchildPid)], statusEnv, undefined, tmp);
    expect(stall.status).toBe(0);
    expect(stall.stdout).toContain('(watchdog terminated a recent cursor call, see run.log)');
    expect(stall.stdout).not.toContain('recent claude call');

    process.kill(run.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(run.grandchildPid)).toBe(false);
  }, 120_000);
});

describe('status convergence proof', () => {
  it('reports rich iteration health and never infers convergence from a final artifact', async () => {
    const run = await launchHangingRun('proof-status');
    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    for (let version = 0; version <= 2; version += 1) {
      writeStructuredPlanFile(path.join(run.work, `plan.v${version}.md`), `Plan ${version}`);
    }
    writeFileSync(path.join(run.work, 'rejected-log.jsonl'), `${JSON.stringify({ id: 'r1' })}\n`);
    writeStatusCritique(path.join(run.work, 'critique.v0.json'), 0, [
      statusIssue('C1'),
      statusIssue('C2'),
      statusIssue('C3'),
    ]);
    writeStatusCritique(path.join(run.work, 'critique.v1.json'), 1, [statusIssue('C1')]);
    writeFileSync(
      path.join(run.work, 'update.v0.json'),
      `${JSON.stringify({ issues: [{ id: 'C3', verdict: 'reject_hallucinated' }] })}\n`,
    );
    writeStatusCritique(path.join(run.work, 'critique.v2.json'), 2, [
      statusIssue('C1'),
      statusIssue('C2', { addresses: 'v1.C1' }),
      statusIssue('C3', { addresses: 'v0.C3' }),
      statusIssue('C4', { addresses: 'v0.C2' }),
      statusIssue('C5', { introduced_by_revision: 'plan.v2.md' }),
      statusIssue('C6', { severity: 'nit', duplicate_of: 'r1' }),
      statusIssue('C7', {
        addresses: 'v9.C1',
        evidence_refs: [{ kind: 'repository', value: 'source.ts:2' }],
      }),
    ]);

    const planSha256 = fileSha256(path.join(run.work, 'plan.v2.md'));
    const criticBinding = {
      candidate: {
        kind: 'versioned-plan' as const,
        planVersion: 2,
        contentDigest: planSha256,
      },
      lineage: {
        evaluationStage: 'review' as const,
        lineageDigest: 'c'.repeat(64),
      },
    };
    const catalog = createReadinessProofCatalog({
      expectedPlanVersion: 2,
      invariants: [
        { invariantId: 'I-active', occurrenceIds: ['O-active'] },
        { invariantId: 'I-resolved', occurrenceIds: ['O-resolved'] },
      ],
      materialIssueIds: [],
    });
    let proof = createReadinessProofState(catalog, {
      critic: {
        required: true,
        reason: 'independent-critic-required',
        expectedBinding: criticBinding,
      },
    });
    proof = recordContextDelivery(proof, {
      role: 'critic',
      stage: 'review',
      planVersion: 2,
      mandatoryBytes: 120,
      optionalBytes: 30,
      totalInputBytes: 150,
      inputTokenLimit: null,
      inputLimitSource: 'unknown',
      reductions: [],
      omittedCategories: ['resolved-minor-history'],
    });
    proof = replaceOccurrenceCoverageSnapshot(proof, {
      source: 'critic',
      catalogDigest: catalog.digest,
      binding: criticBinding,
      occurrences: [
        {
          invariantId: 'I-active',
          occurrenceId: 'O-active',
          disposition: 'unresolved',
          evidenceGrounded: false,
        },
        {
          invariantId: 'I-resolved',
          occurrenceId: 'O-resolved',
          disposition: 'satisfied',
          evidenceGrounded: true,
        },
      ],
    });
    writeReadinessProofState(path.join(run.work, 'convergence.v2.json'), proof);
    writeFileSync(
      path.join(run.work, 'system-check.v2.json'),
      `${JSON.stringify({ relationships: [{ id: 'R-fixture', disposition: 'covered' }] })}\n`,
    );
    writeStructuredPlanFile(path.join(run.work, 'plan.final.md'), 'Final plan', {
      status: 'needs-review',
    });
    const stateDir = path.join(tmp, 'state');
    const record = readRunRecords(stateDir).find((entry) => entry.pid === run.pid);
    expect(record).toBeDefined();
    if (record === undefined) {
      throw new TypeError('launched run record is unavailable');
    }
    expect(record.workDir).toBe(realpathSync(run.work));
    finalizeRunRecord(stateDir, record.runId, {
      state: 'finished',
      exitCode: 0,
      endedAt: '2026-06-15T01:00:00Z',
      final: finalProjection(record.workDir, {
        status: 'needs-review',
        decision: 'unable-to-decide',
        reasonCodes: ['occurrence-proof-unresolved'],
      }),
    });

    const status = runCli(['status', String(run.grandchildPid)], statusEnv, undefined, tmp);
    expect(status.status).toBe(0);
    expect(status.stdout).toContain('lineage={"new":1');
    expect(status.stdout).toContain(
      '"revision-regression":1,"rejected-duplicate":1,"invalid-lineage":4',
    );
    expect(status.stdout).toContain(
      'grounding={"grounded":6,"malformed":0,"format-mismatch":1,"unanchored":0}',
    );
    expect(status.stdout).toContain('retained=120B+30B');
    expect(status.stdout).toContain('invariants=2/1/1');
    expect(status.stdout).toContain('relationships=1/1');
    expect(status.stdout).toContain('omitted=resolved-minor-history');
    expect(status.stdout).toContain(
      'final artifact present; status=needs-review decision=unable-to-decide',
    );
    expect(status.stdout).not.toContain('✓ ready');
    expect(readFileSync(run.log, 'utf8')).not.toContain(RUN_INPUT_BODY_SENTINEL);

    writeStructuredPlanFile(path.join(run.work, 'plan.final.md'), 'Clean final');
    appendFileSync(path.join(run.work, 'plan.final.md'), '\nSame-version mutation\n');
    const staleProof = runCli(['status', String(run.grandchildPid)], statusEnv, undefined, tmp);
    expect(staleProof.status).toBe(0);
    expect(staleProof.stdout).toContain(
      'final artifact present; status=needs-review decision=unable-to-decide',
    );
    expect(staleProof.stdout).not.toContain('✓ ready');

    finalizeRunRecord(stateDir, record.runId, { final: finalProjection(record.workDir) });
    const exactProof = runCli(['status', String(run.grandchildPid)], statusEnv, undefined, tmp);
    expect(exactProof.status).toBe(0);
    expect(exactProof.stdout).toContain('✓ ready (final status clean; exact plan bound)');

    writeFileSync(path.join(run.work, 'critique.v3.json'), '{"interrupted":');
    const interrupted = runCli(['status', String(run.grandchildPid)], statusEnv, undefined, tmp);
    expect(interrupted.status).toBe(0);
    expect(interrupted.stdout).toContain('proof: lineage=unavailable grounding=unavailable');
    expect(interrupted.stdout).toContain('✓ ready (final status clean; exact plan bound)');

    writeStructuredPlanFile(path.join(run.work, 'plan.final.md'), 'Blocked final', {
      status: 'blocked',
    });
    const structuralReason =
      'plan shape broken (title=1 missing_sections=1 impact_graph_mermaid=0 frontmatter=0)';
    finalizeRunRecord(stateDir, record.runId, {
      state: 'blocked',
      exitCode: 6,
      endedAt: '2026-06-15T02:00:00Z',
      final: finalProjection(record.workDir, {
        status: 'blocked',
        structuralStatus: 'blocked',
        structuralReason,
        decision: 'unable-to-decide',
        reasonCodes: ['final-artifact-needs-review'],
        reasons: [
          structuralReason,
          'Readiness proof: unable-to-decide:final-artifact-needs-review',
        ],
      }),
    });
    const blocked = runCli(['status', String(run.grandchildPid)], statusEnv, undefined, tmp);
    expect(blocked.status).toBe(0);
    expect(blocked.stdout).toContain(
      `final artifact present; status=blocked decision=unable-to-decide reasons=${structuralReason}`,
    );
    expect(blocked.stdout).not.toContain('final artifact present; status=needs-review');

    process.kill(run.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(run.grandchildPid)).toBe(false);
  }, 120_000);
});

describe('cross-store discovery', () => {
  it('lists a project-local self-planning run with no STATE_DIR/PLANS_DIR at status time', async () => {
    const projRun = await launchHangingRun('proj', {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, '.agents', 'plans'),
      AGENT_QUORUM_STATE_DIR: undefined,
    });
    const listEnv = {
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
      AGENT_QUORUM_PLANS_DIR: undefined,
      AGENT_QUORUM_STATE_DIR: undefined,
    };

    const listing = runCli(['status'], listEnv, undefined, tmp);
    expect(listing.status).toBe(0);
    expect(listing.stdout).toContain('found 1 agent-quorum run(s)');
    expect(listing.stdout).toContain('proj  [running]');
    // Missing known stores still leave discovery at exit 0.
    expect(existsSync(path.join(tmp, 'home', 'state'))).toBe(false);

    process.kill(projRun.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(projRun.grandchildPid)).toBe(false);
  }, 120_000);

  it('--store scopes the listing to one store, ignoring a live run elsewhere', async () => {
    const live = await launchHangingRun('delta');
    const emptyStore = path.join(tmp, 'empty-state');
    mkdirSync(emptyStore, { recursive: true });
    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    const scoped = runCli(['status', '--store', emptyStore], statusEnv, undefined, tmp);
    expect(scoped.status).toBe(0);
    expect(scoped.stderr).toContain('no agent-quorum runs currently active');

    const aggregated = runCli(['status'], statusEnv, undefined, tmp);
    expect(aggregated.status).toBe(0);
    expect(aggregated.stdout).toContain('delta  [running]');

    process.kill(live.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(live.grandchildPid)).toBe(false);
  }, 120_000);

  it('status --watch <selector> --store <dir> emits one snapshot resolved from that store', async () => {
    const run = await launchHangingRun('epsilon');
    const statusEnv = {
      AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
      AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
      AGENT_QUORUM_HOME: path.join(tmp, 'home'),
      AGENT_QUORUM_STATUS_SCAN_PS: '0',
    };

    const snapshot = runCli(
      ['status', '--watch', 'epsilon', '--store', path.join(tmp, 'state')],
      statusEnv,
      undefined,
      tmp,
    );
    expect(snapshot.status).toBe(0);
    expect(snapshot.stdout).toContain('━━ epsilon ━━');

    process.kill(run.pid, 'SIGTERM');
    await sleep(1500);
    expect(isAlive(run.grandchildPid)).toBe(false);
  }, 120_000);
});
