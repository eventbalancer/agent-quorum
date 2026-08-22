import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPlanLoop } from '../../src/index.js';
import {
  captureStderr,
  emptyCritique,
  withEnvAsync,
  writeFakeBin,
  writeReadinessAssessment,
  writeStoreConfig,
  writeStructuredPlanFile,
  type StderrCapture,
} from '../helpers/harness.js';

let tmp: string;
let fake: string;
let work: string;
let input: string;
let standardAssessment: string;
let highRiskAssessment: string;
let capture: StderrCapture;

type EnvOverrides = Record<string, string | undefined>;

function baseEnv(extra: EnvOverrides = {}): EnvOverrides {
  return {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    AGENT_QUORUM_HOME: path.join(tmp, 'home'),
    AGENT_QUORUM_WORK_DIR: work,
    AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
    AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
    AGENT_QUORUM_CLARIFY: '0',
    AGENT_QUORUM_RETRY_COUNT: '0',
    AGENT_QUORUM_RETRY_DELAY_SECONDS: '0',
    AGENT_QUORUM_RESUME: undefined,
    FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
    FAKE_CLAUDE_PROMPT: path.join(tmp, 'claude.prompt'),
    ...extra,
  };
}

function writeVerdict(name: string, ready = true): string {
  const file = path.join(tmp, `${name}.json`);
  writeFileSync(
    file,
    `${JSON.stringify(
      {
        ready,
        rationale: `${name} rationale`,
        coverage_complete: true,
        unresolved_occurrence_ids: [],
        invariant_assessments: [],
      },
      null,
      2,
    )}\n`,
  );
  return file;
}

function extendCritique(
  file: string,
  extension: {
    readonly boundary_challenges?: readonly unknown[];
    readonly opportunities?: readonly unknown[];
  },
): void {
  const critique = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  Object.assign(critique, extension);
  writeFileSync(file, `${JSON.stringify(critique, null, 2)}\n`);
}

async function run(
  quality: 'quick' | 'balanced',
  environment: EnvOverrides,
): ReturnType<typeof runPlanLoop> {
  return withEnvAsync(baseEnv(environment), () =>
    runPlanLoop({
      input,
      iters: 2,
      quality,
      fix: false,
      translate: false,
      workDir: work,
    }),
  );
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-bounded-readiness.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'));
  mkdirSync(path.join(tmp, 'state'));
  writeStoreConfig(path.join(tmp, 'home'));
  input = path.join(tmp, 'input.md');
  writeStructuredPlanFile(input, 'Bounded Readiness Input');
  standardAssessment = path.join(tmp, 'readiness-standard.json');
  highRiskAssessment = path.join(tmp, 'readiness-high.json');
  writeReadinessAssessment(standardAssessment);
  writeReadinessAssessment(highRiskAssessment, true);
  capture = captureStderr();
});

afterEach(() => {
  capture.restore();
  rmSync(tmp, { recursive: true, force: true });
});

describe('bounded planning readiness', () => {
  it('marks a balanced standard-risk clean pass ready without invoking Judge', async () => {
    const critique = path.join(tmp, 'clean.json');
    emptyCritique(critique);
    const judgeCalls = path.join(tmp, 'judge.calls');

    const result = await run('balanced', {
      FAKE_READINESS_ASSESSMENT: standardAssessment,
      FAKE_CODEX_OUTPUT: critique,
      FAKE_CLAUDE_JSON_CALLS: judgeCalls,
    });

    expect(result.status).toBe('clean');
    expect(result.convergence).toMatchObject({
      decision: 'ready',
      satisfied: true,
      applicableRiskDomains: ['correctness'],
      highRiskDomains: [],
    });
    expect(existsSync(judgeCalls)).toBe(false);
    expect(existsSync(path.join(work, 'judge.v0.json'))).toBe(false);
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(false);
    expect(capture.text()).toContain('ready at v0');
  });

  it('runs intermediate and final Judge for balanced high-risk work', async () => {
    const critique = path.join(tmp, 'clean.json');
    emptyCritique(critique);
    const verdict = writeVerdict('ready');
    const judgeCalls = path.join(tmp, 'judge.calls');

    const result = await run('balanced', {
      FAKE_READINESS_ASSESSMENT: highRiskAssessment,
      FAKE_CODEX_OUTPUT: critique,
      FAKE_CLAUDE_JSON_RESULT: verdict,
      FAKE_CLAUDE_JSON_CALLS: judgeCalls,
    });

    expect(result.status).toBe('clean');
    expect(result.convergence).toMatchObject({
      decision: 'ready',
      satisfied: true,
      highRiskDomains: ['correctness'],
    });
    expect(readFileSync(judgeCalls, 'utf8')).toBe('2');
    expect(existsSync(path.join(work, 'judge.v0.json'))).toBe(true);
    expect(existsSync(path.join(work, 'judge.final.json'))).toBe(true);
    expect(capture.text()).toContain('intermediate judge');
    expect(capture.text()).toContain('final Judge');
  });

  it('stops on a boundary challenge without asking the creator to revise scope', async () => {
    const critique = path.join(tmp, 'boundary.json');
    emptyCritique(critique);
    extendCritique(critique, {
      boundary_challenges: [
        {
          id: 'B1',
          kind: 'scope-expansion',
          claim: 'A second repository must enter the implementation boundary.',
          rationale: 'The frozen boundary covers only the fixture implementation.',
          evidence: 'readiness-contract.json boundary.inScope',
          evidence_refs: [{ kind: 'plan-section', section: 'Scope' }],
        },
      ],
    });
    const creatorCalls = path.join(tmp, 'creator.calls');

    const result = await run('balanced', {
      FAKE_READINESS_ASSESSMENT: standardAssessment,
      FAKE_CODEX_OUTPUT: critique,
      FAKE_CLAUDE_JSON_CALLS: creatorCalls,
    });

    expect(result.status).toBe('needs-review');
    expect(result.convergence).toMatchObject({
      decision: 'unable-to-decide',
      satisfied: false,
    });
    expect(result.convergence?.reasonCodes).toContain('boundary-challenge');
    expect(result.convergence?.unresolvedCoverage).toContain('boundary-challenge:B1');
    expect(existsSync(creatorCalls)).toBe(false);
    expect(existsSync(path.join(work, 'update.v0.json'))).toBe(false);
    expect(existsSync(path.join(work, 'plan.v1.md'))).toBe(false);
    expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toContain(
      '# Bounded Readiness Input',
    );
  });

  it('reports assurance-appetite exhaustion before reviewing quick high-risk work', async () => {
    const critique = path.join(tmp, 'clean.json');
    emptyCritique(critique);

    const result = await run('quick', {
      FAKE_READINESS_ASSESSMENT: highRiskAssessment,
      FAKE_CODEX_OUTPUT: critique,
    });

    expect(result.status).toBe('needs-review');
    expect(result.convergence).toMatchObject({
      decision: 'limits-exhausted',
      satisfied: false,
      exhaustedLimits: ['assurance-appetite'],
      reasonCodes: ['assurance-appetite'],
      highRiskDomains: ['correctness'],
    });
    expect(existsSync(path.join(work, 'critique.v0.json'))).toBe(false);
    expect(existsSync(path.join(work, 'readiness-contract.json'))).toBe(true);
  });

  it('persists opportunities without triggering a creator update', async () => {
    const critique = path.join(tmp, 'opportunity.json');
    emptyCritique(critique);
    extendCritique(critique, {
      opportunities: [
        {
          fingerprint: 'fixture-readable-heading',
          claim: 'The verification heading could be more specific.',
          evidence: '## Verification',
          suggested_improvement: 'Name the deterministic fixture check in the heading.',
          evidence_refs: [{ kind: 'plan-section', section: 'Verification' }],
        },
      ],
    });
    const creatorCalls = path.join(tmp, 'creator.calls');

    const result = await run('balanced', {
      FAKE_READINESS_ASSESSMENT: standardAssessment,
      FAKE_CODEX_OUTPUT: critique,
      FAKE_CLAUDE_JSON_CALLS: creatorCalls,
    });

    expect(result.status).toBe('clean');
    expect(result.convergence).toMatchObject({ decision: 'ready', opportunityCount: 1 });
    expect(existsSync(creatorCalls)).toBe(false);
    expect(existsSync(path.join(work, 'update.v0.json'))).toBe(false);
    expect(JSON.parse(readFileSync(path.join(work, 'opportunities.json'), 'utf8'))).toEqual({
      schemaVersion: 1,
      opportunities: [
        {
          fingerprint: 'fixture-readable-heading',
          claim: 'The verification heading could be more specific.',
          evidence: '## Verification',
          suggestedImprovement: 'Name the deterministic fixture check in the heading.',
          evidenceRefs: [{ kind: 'plan-section', section: 'Verification' }],
          firstSeenPlanVersion: 0,
          lastSeenPlanVersion: 0,
        },
      ],
    });
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain('opportunities=1');
  });

  it('preserves the frozen contract digest and opportunity ledger across resume', async () => {
    const firstCritique = path.join(tmp, 'first-opportunity.json');
    emptyCritique(firstCritique);
    extendCritique(firstCritique, {
      opportunities: [
        {
          fingerprint: 'fixture-resume-opportunity',
          claim: 'The resume note could include a concise example.',
          evidence: '## Context',
          suggested_improvement: 'Add one non-blocking resume example.',
          evidence_refs: [{ kind: 'plan-section', section: 'Context' }],
        },
      ],
    });
    const first = await run('balanced', {
      FAKE_READINESS_ASSESSMENT: standardAssessment,
      FAKE_CODEX_OUTPUT: firstCritique,
    });
    expect(first.convergence?.decision).toBe('ready');
    const contractBefore = readFileSync(path.join(work, 'readiness-contract.json'));
    const contractDigest = (
      JSON.parse(contractBefore.toString('utf8')) as { contractDigest: string }
    ).contractDigest;
    const opportunitiesBefore = readFileSync(path.join(work, 'opportunities.json'));

    const secondCritique = path.join(tmp, 'second-clean.json');
    emptyCritique(secondCritique);
    const second = await run('balanced', {
      AGENT_QUORUM_RESUME: '1',
      FAKE_READINESS_ASSESSMENT: standardAssessment,
      FAKE_CODEX_OUTPUT: secondCritique,
    });

    expect(second.convergence).toMatchObject({
      decision: 'ready',
      opportunityCount: 1,
    });
    expect(readFileSync(path.join(work, 'readiness-contract.json'))).toEqual(contractBefore);
    expect(second.convergence?.artifactPath).toBe(
      path.join(second.workDir ?? work, 'convergence.final.json'),
    );
    const resumedState = JSON.parse(
      readFileSync(path.join(work, 'convergence.final.json'), 'utf8'),
    ) as { readinessContractDigest: string };
    expect(resumedState.readinessContractDigest).toBe(contractDigest);
    expect(readFileSync(path.join(work, 'opportunities.json'))).toEqual(opportunitiesBefore);
    expect(readFileSync(path.join(work, 'summary.md'), 'utf8')).toContain('- resume_start: 0');
  });

  it('requires a fresh exact critique when resumed proof is not bound to the frozen contract', async () => {
    const firstCritique = path.join(tmp, 'first-clean.json');
    emptyCritique(firstCritique);
    const first = await run('balanced', {
      FAKE_READINESS_ASSESSMENT: standardAssessment,
      FAKE_CODEX_OUTPUT: firstCritique,
    });
    expect(first.convergence?.decision).toBe('ready');

    const stateFile = path.join(work, 'convergence.v0.json');
    const unbound = JSON.parse(readFileSync(stateFile, 'utf8')) as Record<string, unknown>;
    expect(unbound).toMatchObject({
      lastCritiquedPlanVersion: 0,
      scanComplete: true,
      systemCheckPassed: true,
    });
    delete unbound.readinessContractDigest;
    writeFileSync(stateFile, `${JSON.stringify(unbound, null, 2)}\n`);

    const secondCritique = path.join(tmp, 'second-clean.json');
    const criticCalls = path.join(tmp, 'resume-critic.calls');
    emptyCritique(secondCritique);
    const second = await run('balanced', {
      AGENT_QUORUM_RESUME: '1',
      FAKE_READINESS_ASSESSMENT: standardAssessment,
      FAKE_CODEX_OUTPUT: secondCritique,
      FAKE_CODEX_OUTPUT_CALLS: criticCalls,
    });

    expect(readFileSync(criticCalls, 'utf8')).toBe('1');
    expect(second.convergence).toMatchObject({ decision: 'ready', satisfied: true });
    const resumedState = JSON.parse(
      readFileSync(path.join(work, 'convergence.final.json'), 'utf8'),
    ) as {
      lastCritiquedPlanVersion: number;
      scanComplete: boolean;
      riskDomains: {
        domain: string;
        complete: boolean;
        lastAssessedPlanVersion?: number;
      }[];
      unresolvedCoverage: string[];
    };
    expect(resumedState.lastCritiquedPlanVersion).toBe(0);
    expect(resumedState.scanComplete).toBe(true);
    expect(
      resumedState.riskDomains.find((domain) => domain.domain === 'correctness'),
    ).toMatchObject({ complete: true, lastAssessedPlanVersion: 0 });
    expect(resumedState.unresolvedCoverage).not.toContain(
      'plan.v0:readiness-contract-proof-unbound',
    );
  });
});
