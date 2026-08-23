import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveResumeWorkdir } from '../../src/core/resume.js';
import { admitCreatorUpdate } from '../../src/core/readiness-admission.js';
import type { ResumeState, RunContext } from '../../src/core/run-context.js';
import {
  applyFrozenReadinessContract,
  bindCanonicalPlan,
  bindVersionedPlan,
  createOccurrenceSourceBinding,
  createReadinessProofCatalog,
  createReadinessProofState,
  recordAdmittedCreatorUpdate,
  recordAdmittedCritique,
  recordAdmittedFixReviewerProof,
  recordAdmittedJudgeProof,
  recordInterventions,
  recordSystemProof,
  reduceReadinessProofState,
  setOccurrenceSourceRequirement,
  type OccurrenceCoverageSnapshot,
  type ReadinessProofState,
} from '../../src/core/readiness-proof.js';
import { writeReadinessProofState } from '../../src/core/readiness-store.js';
import {
  buildReadinessContract,
  RISK_DOMAINS,
  writeFrozenReadinessContract,
  type ReadinessContract,
} from '../../src/core/readiness-contract.js';
import { fileSha256, sha256 } from '../../src/core/digest.js';
import type { JsonValue } from '../../src/core/json.js';
import { validateSystemCoverage, writeSystemCheck } from '../../src/core/system-context.js';
import { HaltError } from '../../src/runtime/halt.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { archiveResumeStale, lastStablePlan, prepareResume } from '../../src/stages/plan/resume.js';
import {
  captureStderr,
  writeAcceptUpdate,
  writeCritique,
  writeStructuredPlanFile,
  writeUpdate,
} from '../helpers/harness.js';
import { TEST_SOURCE_DIGEST, makeTestRunContext } from '../helpers/test-context.js';

let tmp: string;
let work: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-resumetest.'));
  work = path.join(tmp, 'work');
  mkdirSync(work);
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

interface ProofFixtureOptions {
  readonly planVersion?: number;
  readonly highRisk?: boolean;
  readonly reviewed?: boolean;
  readonly deterministic?: boolean;
  readonly authoritativeDigest?: string;
  readonly materialQuestionIds?: readonly string[];
}

interface ProofFixture {
  readonly contract: ReadinessContract;
  readonly state: ReadinessProofState;
  readonly planFile: string;
  readonly proofFile: string;
}

function fixtureContract(
  state: ReadinessProofState,
  highRisk: boolean,
  materialQuestionIds: readonly string[] = [],
): ReadinessContract {
  return buildReadinessContract({
    assessment: {
      boundary: {
        goal: 'Resume the selected current-version plan safely.',
        in_scope: ['Selected versioned plan'],
        out_of_scope: ['Unrequested changes'],
        constraints: ['Keep the frozen contract immutable'],
      },
      domain_assessments: RISK_DOMAINS.map((domain) => ({
        domain,
        applicability: highRisk && domain === 'correctness' ? 'applicable' : 'not-applicable',
        risk: highRisk && domain === 'correctness' ? 'high' : 'standard',
        rationale: `Fixture assessment for ${domain}.`,
        evidence_refs: [],
      })),
      material_questions: materialQuestionIds.map((id) => ({
        id,
        question: `Resolve ${id} before resuming?`,
        rationale: `${id} changes the frozen readiness boundary.`,
        options: ['yes', 'no'],
      })),
    },
    sourceDigest: state.sourceDigest,
    systemDigest: state.authoritativeDigest,
    quality: state.quality,
    iterationLimit: state.iterationLimit,
    issueBudget: state.issueBudget.limit,
    operatorDecisionIds: [],
  });
}

function occurrenceSnapshot(
  state: ReadinessProofState,
  source: OccurrenceCoverageSnapshot['source'],
  binding: OccurrenceCoverageSnapshot['binding'],
): OccurrenceCoverageSnapshot {
  return {
    source,
    catalogDigest: state.catalog.digest,
    binding,
    occurrences: state.catalog.invariants.flatMap((invariant) =>
      invariant.occurrenceIds.map((occurrenceId) => ({
        invariantId: invariant.invariantId,
        occurrenceId,
        disposition: 'satisfied' as const,
        evidenceGrounded: true as const,
      })),
    ),
  };
}

function writeCurrentProof(ctx: RunContext, options: ProofFixtureOptions = {}): ProofFixture {
  const planVersion = options.planVersion ?? 0;
  const planFile = path.join(work, `plan.v${planVersion}.md`);
  if (!existsSync(planFile)) {
    writeStructuredPlanFile(planFile, `V${planVersion}`);
  }
  const catalog = createReadinessProofCatalog({
    expectedPlanVersion: planVersion,
    invariants: [],
    materialIssueIds: [],
  });
  let state = createReadinessProofState({
    quality: ctx.settings.quality,
    matrix: ctx.quality,
    mode: ctx.mode,
    sourceDigest: ctx.readinessProof.sourceDigest,
    authoritativeDigest: options.authoritativeDigest ?? ctx.systemContext.digest,
    relationshipIds: [],
    maxIters: ctx.settings.maxIters,
    trustedCatalog: catalog,
    findings: [],
    invariants: [],
  });
  const contract = fixtureContract(state, options.highRisk ?? false, options.materialQuestionIds);
  writeFrozenReadinessContract(path.join(work, 'readiness-contract.json'), contract);
  state = applyFrozenReadinessContract(state, contract);
  const planSha256 = fileSha256(planFile);
  const critic = createOccurrenceSourceBinding(state, {
    source: 'critic',
    candidateKind: 'versioned-plan',
    contentDigest: planSha256,
  });
  const intermediateJudge = options.highRisk
    ? createOccurrenceSourceBinding(state, {
        source: 'intermediate-judge',
        candidateKind: 'versioned-plan',
        contentDigest: planSha256,
      })
    : undefined;
  state = bindVersionedPlan(state, {
    planVersion,
    planSha256,
    criticLineageDigest: critic.lineage.lineageDigest,
    ...(intermediateJudge === undefined
      ? {}
      : { intermediateJudgeLineageDigest: intermediateJudge.lineage.lineageDigest }),
  });

  if (options.reviewed) {
    state = recordAdmittedCritique(state, {
      planVersion,
      snapshot: occurrenceSnapshot(state, 'critic', critic),
      scanComplete: true,
      declaredScopeVerified: true,
      materialIssueIds: [],
      issueBudgetUsed: 0,
      issueBudgetExhausted: false,
      riskDomains: state.riskDomains.map((domain) => ({
        ...domain,
        complete: true,
        lastAssessedPlanVersion: planVersion,
      })),
      criticCoverageGapIds: [],
      criticScopeCoverageGapIds: [],
      criticContextGapIds: [],
      boundaryChallenges: [],
      opportunities: [],
    });
    if (intermediateJudge !== undefined) {
      state = recordAdmittedJudgeProof(state, {
        stage: 'intermediate',
        snapshot: occurrenceSnapshot(state, 'intermediate-judge', intermediateJudge),
        verdict: true,
        approvedPlanVersion: planVersion,
        materialIssueIds: [],
      });
    }
  }

  if (options.deterministic) {
    const check = validateSystemCoverage(ctx.systemContext, planFile, planVersion, {
      required: false,
      inScope: contract.boundary.inScope,
      outOfScope: contract.boundary.outOfScope,
    });
    state = recordSystemProof(state, {
      binding: {
        planVersion,
        planSha256: check.planSha256,
        authoritativeDigest: state.authoritativeDigest,
      },
      passed: check.passed,
      mismatchIds: check.mismatches,
      unavailableEvidenceIds: check.requiredEvidenceUnavailable,
    });
    writeSystemCheck(work, check);
  }

  const proofFile = path.join(work, `convergence.v${planVersion}.json`);
  writeReadinessProofState(proofFile, state);
  return { contract, state, planFile, proofFile };
}

interface StableRevisionOptions {
  readonly acceptedIssue?: boolean;
}

function writeStableRevision(
  ctx: RunContext,
  options: StableRevisionOptions = {},
): {
  readonly v0: ProofFixture;
  readonly v1: ProofFixture;
} {
  writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
  writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
  const v0 = writeCurrentProof(ctx, { planVersion: 0 });
  const critiqueFile = path.join(work, 'critique.v0.json');
  const updateFile = path.join(work, 'update.v0.json');
  const planFile = path.join(work, 'plan.v1.md');
  const planContent = readFileSync(planFile, 'utf8');
  const issue: {
    id: string;
    addresses: null;
    severity: 'major';
    category: string;
    claim: string;
    evidence: string;
    evidence_refs: JsonValue[];
    suggested_fix: string;
    confidence: number;
    duplicate_of: null;
  } = {
    id: 'C1',
    addresses: null,
    severity: 'major',
    category: 'correctness',
    claim: 'Retain the admitted creator transition.',
    evidence: '## Work Plan',
    evidence_refs: [{ kind: 'plan-section', section: 'Work Plan' }],
    suggested_fix: 'Record the transition exactly.',
    confidence: 1,
    duplicate_of: null,
  };
  writeCritique(critiqueFile, options.acceptedIssue === true ? [issue] : [], 0);
  const reviewedState = recordAdmittedCritique(v0.state, {
    planVersion: 0,
    snapshot: occurrenceSnapshot(
      v0.state,
      'critic',
      createOccurrenceSourceBinding(v0.state, {
        source: 'critic',
        candidateKind: 'versioned-plan',
        contentDigest: fileSha256(v0.planFile),
      }),
    ),
    scanComplete: true,
    declaredScopeVerified: true,
    materialIssueIds: options.acceptedIssue === true ? ['v0.C1'] : [],
    issueBudgetUsed: options.acceptedIssue === true ? 1 : 0,
    issueBudgetExhausted: false,
    riskDomains: v0.state.riskDomains.map((domain) => ({
      ...domain,
      complete: true,
      lastAssessedPlanVersion: 0,
    })),
    criticCoverageGapIds: [],
    criticScopeCoverageGapIds: [],
    criticContextGapIds: [],
    boundaryChallenges: [],
    opportunities: [],
  });
  writeReadinessProofState(v0.proofFile, reviewedState);
  const reviewedV0 = { ...v0, state: reviewedState };
  if (options.acceptedIssue === true) {
    writeAcceptUpdate(updateFile, 1, planFile);
  } else {
    writeFileSync(
      updateFile,
      `${JSON.stringify(
        {
          plan_version: 1,
          plan_markdown: planContent,
          issues: [],
          applied: [],
          systemic_dispositions: [],
          rejected_append: [],
        },
        null,
        2,
      )}\n`,
    );
  }
  const update = JSON.parse(readFileSync(updateFile, 'utf8')) as JsonValue;
  const admitted = admitCreatorUpdate({
    value: update,
    currentCatalog: reviewedState.catalog,
    fromPlanVersion: 0,
    expectedPlanVersion: 1,
    expectedIssues:
      options.acceptedIssue === true
        ? [
            {
              id: issue.id,
              severity: issue.severity,
              claim: issue.claim,
              evidence: issue.evidence,
              suggestedFix: issue.suggested_fix,
              provenance: 'critic',
            },
          ]
        : [],
    retainedFindings: reviewedState.findings,
    retainedInvariants: reviewedState.invariants,
    evidenceContext: {
      work,
      projectRoot: ctx.provider.projectRoot,
      planVersion: 1,
      candidateContent: planContent,
      candidatePath: planFile,
    },
    operatorInterventionIds: reviewedState.interventionIds,
    admittedCriticIssueRefs: reviewedState.admittedCriticIssueRefs,
    admittedJudgeRevisionIssueIds: [],
  });
  let state = recordAdmittedCreatorUpdate(reviewedState, admitted);
  const critic = createOccurrenceSourceBinding(state, {
    source: 'critic',
    candidateKind: 'versioned-plan',
    contentDigest: fileSha256(planFile),
  });
  state = bindVersionedPlan(state, {
    planVersion: 1,
    planSha256: fileSha256(planFile),
    criticLineageDigest: critic.lineage.lineageDigest,
  });
  state = recordAdmittedCritique(state, {
    planVersion: 1,
    snapshot: occurrenceSnapshot(state, 'critic', critic),
    scanComplete: true,
    declaredScopeVerified: true,
    materialIssueIds: [],
    issueBudgetUsed: 0,
    issueBudgetExhausted: false,
    riskDomains: state.riskDomains.map((domain) => ({
      ...domain,
      complete: true,
      lastAssessedPlanVersion: 1,
    })),
    criticCoverageGapIds: [],
    criticScopeCoverageGapIds: [],
    criticContextGapIds: [],
    boundaryChallenges: [],
    opportunities: [],
  });
  const check = validateSystemCoverage(ctx.systemContext, planFile, 1, {
    required: false,
    inScope: v0.contract.boundary.inScope,
    outOfScope: v0.contract.boundary.outOfScope,
  });
  state = recordSystemProof(state, {
    binding: {
      planVersion: 1,
      planSha256: check.planSha256,
      authoritativeDigest: state.authoritativeDigest,
    },
    passed: check.passed,
    mismatchIds: check.mismatches,
    unavailableEvidenceIds: check.requiredEvidenceUnavailable,
  });
  writeSystemCheck(work, check);
  const proofFile = path.join(work, 'convergence.v1.json');
  writeReadinessProofState(proofFile, state);
  const v1 = { contract: v0.contract, state, planFile, proofFile };
  return { v0: reviewedV0, v1 };
}

function noArchiveCreated(): boolean {
  return !readdirSync(work).some((name) => name.startsWith('stale.'));
}

describe('last stable plan', () => {
  it('requires a matching current-schema proof even for v0', () => {
    const scratch = Scratch.create('resume-missing-v0-proof');
    const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    const capture = captureStderr();
    try {
      expect(() => lastStablePlan(ctx)).toThrow(HaltError);
      expect(capture.text()).toContain('no stable plan.vN.md found');
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it('selects v0 when its schema-3 proof is valid and bound', () => {
    const scratch = Scratch.create('resume-stable-v0');
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      writeCurrentProof(ctx);
      expect(lastStablePlan(ctx)).toBe(0);
    } finally {
      scratch.sweep();
    }
  });

  it('skips a revision whose proof is missing', () => {
    const scratch = Scratch.create('resume-missing-revision-proof');
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      writeCurrentProof(ctx);
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      writeUpdate(
        path.join(work, 'update.v0.json'),
        1,
        readFileSync(path.join(work, 'plan.v1.md'), 'utf8'),
      );
      expect(lastStablePlan(ctx)).toBe(0);
    } finally {
      scratch.sweep();
    }
  });

  it.each([
    ['corrupt', '{'],
    ['unsupported', '{"schemaVersion":2}'],
  ])('rejects a %s proof instead of falling back', (_label, serialized) => {
    const scratch = Scratch.create('resume-invalid-revision-proof');
    const capture = captureStderr();
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      writeCurrentProof(ctx);
      writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
      writeUpdate(
        path.join(work, 'update.v0.json'),
        1,
        readFileSync(path.join(work, 'plan.v1.md'), 'utf8'),
      );
      writeFileSync(path.join(work, 'convergence.v1.json'), serialized);
      expect(() => lastStablePlan(ctx)).toThrow(HaltError);
      expect(capture.text()).toContain('invalid readiness proof for plan.v1.md');
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it('falls back when the update does not commit the selected plan bytes', () => {
    const scratch = Scratch.create('resume-update-plan-binding');
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      writeStableRevision(ctx);
      writeUpdate(path.join(work, 'update.v0.json'), 1, '# Different bytes\n');
      expect(lastStablePlan(ctx)).toBe(0);
    } finally {
      scratch.sweep();
    }
  });

  it('rejects creator-invented rejected ledger entries before selecting a revision', () => {
    const scratch = Scratch.create('resume-rejected-boundary');
    const capture = captureStderr();
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const rejection = { id: 'C1', claim: 'Rejected optional change', reason: 'not_value_adding' };
      writeStableRevision(ctx);
      const updateFile = path.join(work, 'update.v0.json');
      const update = JSON.parse(readFileSync(updateFile, 'utf8')) as Record<string, unknown>;
      update.rejected_append = [rejection];
      writeFileSync(updateFile, `${JSON.stringify(update, null, 2)}\n`);

      expect(() => lastStablePlan(ctx)).toThrow(HaltError);
      expect(noArchiveCreated()).toBe(true);
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it('rejects schema-valid creator metadata that no longer matches its admitted receipt', () => {
    const scratch = Scratch.create('resume-creator-admission-receipt');
    const capture = captureStderr();
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const { v1 } = writeStableRevision(ctx, { acceptedIssue: true });
      const updateFile = path.join(work, 'update.v0.json');
      const update = JSON.parse(readFileSync(updateFile, 'utf8')) as {
        issues: { verdict: string }[];
        applied: string[];
        systemic_dispositions: JsonValue[];
      };
      const first = update.issues[0];
      if (first === undefined) {
        throw new Error('accepted update fixture is missing C1');
      }
      first.verdict = 'reject_hallucinated';
      update.applied = [];
      update.systemic_dispositions = [];
      writeFileSync(updateFile, `${JSON.stringify(update, null, 2)}\n`);
      const proofBefore = readFileSync(v1.proofFile, 'utf8');
      const updateBefore = readFileSync(updateFile, 'utf8');
      writeFileSync(path.join(work, 'plan.final.md'), 'preserve-me\n');

      expect(() => prepareResume(ctx)).toThrow(HaltError);

      expect(capture.text()).toMatch(/semantic admission|readiness proof receipt/);
      expect(readFileSync(v1.proofFile, 'utf8')).toBe(proofBefore);
      expect(readFileSync(updateFile, 'utf8')).toBe(updateBefore);
      expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe('preserve-me\n');
      expect(noArchiveCreated()).toBe(true);
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it('rejects a current proof whose catalog digest is corrupt', () => {
    const scratch = Scratch.create('resume-incomplete-catalog');
    const capture = captureStderr();
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const fixture = writeCurrentProof(ctx);
      const raw = JSON.parse(readFileSync(fixture.proofFile, 'utf8')) as Record<string, unknown>;
      (raw.catalog as Record<string, unknown>).digest = 'tampered-catalog';
      writeFileSync(fixture.proofFile, `${JSON.stringify(raw, null, 2)}\n`);
      expect(() => lastStablePlan(ctx)).toThrow(HaltError);
      expect(capture.text()).toContain('invalid readiness proof');
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });
});

describe('stale artifact archive', () => {
  it('archives artifacts at or after the resume point plus final extras', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    writeStructuredPlanFile(path.join(work, 'plan.v1.md'), 'V1');
    writeStructuredPlanFile(path.join(work, 'plan.v2.md'), 'V2');
    writeFileSync(path.join(work, 'critique.v0.json'), '{}\n');
    writeFileSync(path.join(work, 'critique.v1.json'), '{}\n');
    writeFileSync(path.join(work, 'judge.v0.json'), '{}\n');
    writeFileSync(path.join(work, 'judge.v1.json'), '{}\n');
    writeFileSync(path.join(work, 'plan.final.md'), '# Final\n');
    writeFileSync(path.join(work, 'fix-review.json'), '{}\n');
    writeFileSync(path.join(work, 'convergence.final.json'), '{}\n');

    const state: ResumeState = { startIter: 1, archivedCount: 0, archiveDir: '' };
    archiveResumeStale(work, state, 1);

    expect(existsSync(path.join(work, 'plan.v1.md'))).toBe(true);
    expect(existsSync(path.join(work, 'plan.v2.md'))).toBe(false);
    expect(existsSync(path.join(work, 'critique.v0.json'))).toBe(true);
    expect(existsSync(path.join(work, 'critique.v1.json'))).toBe(false);
    expect(existsSync(path.join(work, 'judge.v0.json'))).toBe(true);
    expect(existsSync(path.join(work, 'judge.v1.json'))).toBe(false);
    expect(readdirSync(state.archiveDir)).toEqual(
      expect.arrayContaining([
        'plan.v2.md',
        'critique.v1.json',
        'judge.v1.json',
        'plan.final.md',
        'fix-review.json',
        'convergence.final.json',
      ]),
    );
  });

  it('archives package directories without deleting their contents', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    const packageDir = path.join(work, 'plan.package');
    mkdirSync(packageDir);
    writeFileSync(path.join(packageDir, 'README.md'), '# Package\n');
    const state: ResumeState = { startIter: 0, archivedCount: 0, archiveDir: '' };

    archiveResumeStale(work, state, 0);

    expect(existsSync(packageDir)).toBe(false);
    expect(readFileSync(path.join(state.archiveDir, 'plan.package', 'README.md'), 'utf8')).toBe(
      '# Package\n',
    );
  });

  it('does not create an archive for a clean versioned plan', () => {
    writeStructuredPlanFile(path.join(work, 'plan.v0.md'), 'V0');
    const state: ResumeState = { startIter: 0, archivedCount: 0, archiveDir: '' };
    archiveResumeStale(work, state, 0);
    expect(state).toEqual({ startIter: 0, archivedCount: 0, archiveDir: '' });
  });
});

describe('current-version resume proof boundary', () => {
  it.each([
    ['missing', undefined],
    ['unsupported', '{"schemaVersion":1}\n'],
  ])('rejects a %s frozen contract before mutating artifacts', (_label, contractBytes) => {
    const scratch = Scratch.create('resume-invalid-contract');
    const capture = captureStderr();
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const fixture = writeCurrentProof(ctx);
      writeFileSync(path.join(work, 'plan.final.md'), 'preserve-me\n');
      if (contractBytes === undefined) {
        rmSync(path.join(work, 'readiness-contract.json'));
      } else {
        writeFileSync(path.join(work, 'readiness-contract.json'), contractBytes);
      }

      expect(() => prepareResume(ctx)).toThrow(HaltError);
      expect(capture.text()).toContain('readiness contract is missing or invalid');
      expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe('preserve-me\n');
      expect(readFileSync(fixture.proofFile, 'utf8')).toContain('"schemaVersion": 3');
      expect(noArchiveCreated()).toBe(true);
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it.each([
    { name: 'input source', quality: 'balanced' as const, maxIters: 3, source: '9'.repeat(64) },
    { name: 'quality', quality: 'quick' as const, maxIters: 3, source: TEST_SOURCE_DIGEST },
    {
      name: 'iteration limit',
      quality: 'balanced' as const,
      maxIters: 4,
      source: TEST_SOURCE_DIGEST,
    },
  ])('rejects changed $name before archival', (current) => {
    const scratch = Scratch.create(`resume-contract-${current.name.replaceAll(' ', '-')}`);
    const capture = captureStderr();
    try {
      const prior = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      writeCurrentProof(prior);
      writeFileSync(path.join(work, 'plan.final.md'), 'preserve-me\n');
      const ctx = makeTestRunContext(tmp, work, scratch, {
        quality: current.quality,
        maxIters: current.maxIters,
        sourceDigest: current.source,
      });

      expect(() => prepareResume(ctx)).toThrow(HaltError);
      expect(capture.text()).toContain(current.name);
      expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe('preserve-me\n');
      expect(noArchiveCreated()).toBe(true);
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it('rejects a state bound to a different frozen contract digest before archival', () => {
    const scratch = Scratch.create('resume-contract-digest');
    const capture = captureStderr();
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const fixture = writeCurrentProof(ctx);
      const raw = JSON.parse(readFileSync(fixture.proofFile, 'utf8')) as Record<string, unknown>;
      raw.readinessContractDigest = '9'.repeat(64);
      writeFileSync(fixture.proofFile, `${JSON.stringify(raw, null, 2)}\n`);
      writeFileSync(path.join(work, 'plan.final.md'), 'preserve-me\n');

      expect(() => prepareResume(ctx)).toThrow(HaltError);
      expect(capture.text()).toContain('readiness contract digest');
      expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe('preserve-me\n');
      expect(noArchiveCreated()).toBe(true);
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it('rejects a proof that drops a frozen material question before archival', () => {
    const scratch = Scratch.create('resume-contract-material-question');
    const capture = captureStderr();
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const fixture = writeCurrentProof(ctx, { materialQuestionIds: ['Q1'] });
      const tampered = reduceReadinessProofState({
        ...fixture.state,
        unresolvedMaterialQuestionIds: [],
      });
      writeReadinessProofState(fixture.proofFile, tampered);
      writeFileSync(path.join(work, 'plan.final.md'), 'preserve-me\n');

      expect(() => prepareResume(ctx)).toThrow(HaltError);
      expect(capture.text()).toContain('frozen readiness semantics');
      expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe('preserve-me\n');
      expect(noArchiveCreated()).toBe(true);
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it('rejects a proof that weakens a frozen high-risk domain before archival', () => {
    const scratch = Scratch.create('resume-contract-risk-floor');
    const capture = captureStderr();
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const fixture = writeCurrentProof(ctx, { highRisk: true });
      const loweredRisk = reduceReadinessProofState({
        ...fixture.state,
        riskDomains: fixture.state.riskDomains.map((domain) =>
          domain.domain === 'correctness'
            ? { ...domain, applicability: 'not-applicable' as const, risk: 'standard' as const }
            : domain,
        ),
      });
      const tampered = setOccurrenceSourceRequirement(loweredRisk, 'intermediate-judge', {
        required: false,
        reason: 'standard-risk-judge-exempt',
      });
      writeReadinessProofState(fixture.proofFile, tampered);
      writeFileSync(path.join(work, 'plan.final.md'), 'preserve-me\n');

      expect(() => prepareResume(ctx)).toThrow(HaltError);
      expect(capture.text()).toContain('frozen readiness semantics');
      expect(readFileSync(path.join(work, 'plan.final.md'), 'utf8')).toBe('preserve-me\n');
      expect(noArchiveCreated()).toBe(true);
    } finally {
      capture.restore();
      scratch.sweep();
    }
  });

  it('preserves an unchanged current proof and reconciles future ledger entries', () => {
    const scratch = Scratch.create('resume-unchanged-proof');
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const { v1 } = writeStableRevision(ctx);
      const committed = { iter: 0, id: 'C1', claim: 'Committed rejection' };
      const stale = { iter: 1, id: 'C2', claim: 'Interrupted rejection' };
      writeFileSync(
        path.join(work, 'rejected-log.jsonl'),
        `${JSON.stringify(committed)}\n${JSON.stringify(stale)}\n`,
      );
      writeFileSync(path.join(work, 'plan.final.md'), '# Stale final\n');

      expect(prepareResume(ctx)).toBe(1);

      expect(ctx.readinessProof).toEqual(v1.state);
      expect(ctx.lastCritiqueIter).toBe(1);
      expect(readFileSync(path.join(work, 'rejected-log.jsonl'), 'utf8')).toBe(
        `${JSON.stringify(committed)}\n`,
      );
      expect(existsSync(path.join(work, 'plan.final.md'))).toBe(false);
      expect(readdirSync(ctx.resume.archiveDir)).toEqual(
        expect.arrayContaining(['plan.final.md', 'rejected-log.jsonl']),
      );
    } finally {
      scratch.sweep();
    }
  });

  it('invalidates full review proof when selected plan bytes change', () => {
    const scratch = Scratch.create('resume-plan-mutation');
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const fixture = writeCurrentProof(ctx, { reviewed: true, deterministic: true });
      writeFileSync(fixture.planFile, `${readFileSync(fixture.planFile, 'utf8')}\nchanged\n`);
      const changedSha = fileSha256(fixture.planFile);

      expect(prepareResume(ctx)).toBe(0);

      expect(ctx.readinessProof.planSha256).toBe(changedSha);
      expect(ctx.readinessProof.lastCritiquedPlanVersion).toBeUndefined();
      expect(ctx.readinessProof.scanComplete).toBe(false);
      expect(ctx.readinessProof.systemProofBinding).toBeUndefined();
      expect(
        ctx.readinessProof.sources.find((slot) => slot.source === 'critic')?.snapshot,
      ).toBeUndefined();
      expect(ctx.readinessProof.riskDomains.every((domain) => !domain.complete)).toBe(true);
      expect(readdirSync(ctx.resume.archiveDir)).toEqual(
        expect.arrayContaining(['convergence.v0.json', 'system-check.v0.json']),
      );
    } finally {
      scratch.sweep();
    }
  });

  it('rebinds and invalidates stale review lineage', () => {
    const scratch = Scratch.create('resume-stale-review-lineage');
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const fixture = writeCurrentProof(ctx, { reviewed: true, deterministic: true });
      const stale = recordInterventions(fixture.state, { interventionIds: ['I-new-context'] });
      writeReadinessProofState(fixture.proofFile, stale);
      const staleCritic = stale.sources.find((slot) => slot.source === 'critic');

      expect(prepareResume(ctx)).toBe(0);

      const critic = ctx.readinessProof.sources.find((slot) => slot.source === 'critic');
      expect(critic?.snapshot).toBeUndefined();
      expect(critic?.requirement.required).toBe(true);
      expect(
        critic?.requirement.required
          ? critic.requirement.expectedBinding.lineage.lineageDigest
          : undefined,
      ).not.toBe(
        staleCritic?.requirement.required
          ? staleCritic.requirement.expectedBinding.lineage.lineageDigest
          : undefined,
      );
      expect(ctx.readinessProof.lastCritiquedPlanVersion).toBeUndefined();
    } finally {
      scratch.sweep();
    }
  });

  it('refreshes authoritative identity and invalidates dependent review proof', () => {
    const scratch = Scratch.create('resume-authoritative-change');
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      writeCurrentProof(ctx, { reviewed: true, deterministic: true });
      const changedSystemDigest = '3'.repeat(64);
      ctx.systemContext = { ...ctx.systemContext, digest: changedSystemDigest };

      expect(prepareResume(ctx)).toBe(0);

      expect(ctx.readinessProof.authoritativeDigest).toBe(changedSystemDigest);
      expect(ctx.readinessProof.lastCritiquedPlanVersion).toBeUndefined();
      expect(ctx.readinessProof.systemProofBinding).toBeUndefined();
      expect(ctx.readinessProof.sources.every((slot) => slot.snapshot === undefined)).toBe(true);
      expect(readdirSync(ctx.resume.archiveDir)).toEqual(
        expect.arrayContaining(['convergence.v0.json', 'system-check.v0.json']),
      );
    } finally {
      scratch.sweep();
    }
  });

  it.each(['missing', 'corrupt', 'mismatched', 'semantic'] as const)(
    'invalidates only deterministic proof when its artifact is %s',
    (kind) => {
      const scratch = Scratch.create(`resume-system-check-${kind}`);
      try {
        const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
        const fixture = writeCurrentProof(ctx, { reviewed: true, deterministic: true });
        const checkFile = path.join(work, 'system-check.v0.json');
        if (kind === 'missing') {
          rmSync(checkFile);
        } else if (kind === 'corrupt') {
          writeFileSync(checkFile, '{');
        } else if (kind === 'mismatched') {
          const check = JSON.parse(readFileSync(checkFile, 'utf8')) as Record<string, unknown>;
          check.planSha256 = '0'.repeat(64);
          writeFileSync(checkFile, `${JSON.stringify(check, null, 2)}\n`);
        } else {
          const check = JSON.parse(readFileSync(checkFile, 'utf8')) as Record<string, unknown>;
          check.crossRepository = check.crossRepository !== true;
          writeFileSync(checkFile, `${JSON.stringify(check, null, 2)}\n`);
        }

        expect(prepareResume(ctx)).toBe(0);

        expect(ctx.readinessProof.lastCritiquedPlanVersion).toBe(0);
        expect(ctx.readinessProof.scanComplete).toBe(true);
        expect(
          ctx.readinessProof.sources.find((slot) => slot.source === 'critic')?.snapshot,
        ).toEqual(fixture.state.sources.find((slot) => slot.source === 'critic')?.snapshot);
        expect(ctx.readinessProof.systemProofBinding).toBeUndefined();
        expect(ctx.readinessProof.systemCheckPassed).toBe(false);
        expect(readdirSync(ctx.resume.archiveDir)).toContain('convergence.v0.json');
        if (kind !== 'missing') {
          expect(readdirSync(ctx.resume.archiveDir)).toContain('system-check.v0.json');
        }
      } finally {
        scratch.sweep();
      }
    },
  );

  it('clears finalization-only fix-review and canonical proof', () => {
    const scratch = Scratch.create('resume-finalization-proof');
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const fixture = writeCurrentProof(ctx, { reviewed: true, deterministic: true });
      const fixBinding = createOccurrenceSourceBinding(fixture.state, {
        source: 'fix-reviewer',
        candidateKind: 'fix-applied',
        contentDigest: sha256('retained fix candidate'),
      });
      let finalized = recordAdmittedFixReviewerProof(fixture.state, {
        required: true,
        reason: 'fix-pass-replacement-retained',
        expectedBinding: fixBinding,
        snapshot: occurrenceSnapshot(fixture.state, 'fix-reviewer', fixBinding),
        materialIssueIds: [],
      });
      finalized = bindCanonicalPlan(finalized, {
        planVersion: 0,
        canonicalPlanSha256: fileSha256(fixture.planFile),
        compatibleWithVersionedProof: true,
      });
      writeReadinessProofState(fixture.proofFile, finalized);
      writeFileSync(path.join(work, 'fix-review.json'), '{}\n');
      writeFileSync(path.join(work, 'convergence.final.json'), '{}\n');

      expect(prepareResume(ctx)).toBe(0);

      expect(ctx.readinessProof.canonicalPlanSha256).toBeUndefined();
      expect(
        ctx.readinessProof.sources.find((slot) => slot.source === 'fix-reviewer'),
      ).toMatchObject({
        requirement: { required: false, reason: 'not-evaluated-for-current-candidate' },
      });
      expect(
        ctx.readinessProof.sources.find((slot) => slot.source === 'fix-reviewer')?.snapshot,
      ).toBeUndefined();
      expect(ctx.readinessProof.lastCritiquedPlanVersion).toBe(0);
      expect(readdirSync(ctx.resume.archiveDir)).toEqual(
        expect.arrayContaining([
          'fix-review.json',
          'convergence.final.json',
          'convergence.v0.json',
        ]),
      );
    } finally {
      scratch.sweep();
    }
  });

  it('clears final Judge proof without reconstructing it from final artifacts', () => {
    const scratch = Scratch.create('resume-final-judge-proof');
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      const fixture = writeCurrentProof(ctx, {
        highRisk: true,
        reviewed: true,
        deterministic: true,
      });
      const canonicalSha = fileSha256(fixture.planFile);
      const finalBinding = createOccurrenceSourceBinding(fixture.state, {
        source: 'final-judge',
        candidateKind: 'canonical-plan',
        contentDigest: canonicalSha,
      });
      let finalized = bindCanonicalPlan(fixture.state, {
        planVersion: 0,
        canonicalPlanSha256: canonicalSha,
        finalJudgeLineageDigest: finalBinding.lineage.lineageDigest,
        compatibleWithVersionedProof: true,
      });
      finalized = recordAdmittedJudgeProof(finalized, {
        stage: 'final',
        snapshot: occurrenceSnapshot(finalized, 'final-judge', finalBinding),
        verdict: true,
        approvedPlanVersion: 0,
        materialIssueIds: [],
      });
      writeReadinessProofState(fixture.proofFile, finalized);
      writeFileSync(path.join(work, 'judge.final.json'), '{"ready":true}\n');

      expect(prepareResume(ctx)).toBe(0);

      expect(ctx.readinessProof.canonicalPlanSha256).toBeUndefined();
      expect(
        ctx.readinessProof.sources.find((slot) => slot.source === 'final-judge'),
      ).toMatchObject({ requirement: { required: false, reason: 'canonical-plan-not-bound' } });
      expect(
        ctx.readinessProof.sources.find((slot) => slot.source === 'final-judge')?.snapshot,
      ).toBeUndefined();
      expect(ctx.readinessProof.judgeReady).toBeUndefined();
      expect(readdirSync(ctx.resume.archiveDir)).toEqual(
        expect.arrayContaining(['judge.final.json', 'convergence.v0.json']),
      );
    } finally {
      scratch.sweep();
    }
  });

  it('keeps the active rejected ledger intact when atomic reconciliation cannot commit', () => {
    const scratch = Scratch.create('resume-ledger-atomicity');
    const temporary = path.join(work, `rejected-log.jsonl.resume-${process.pid}`);
    try {
      const ctx = makeTestRunContext(tmp, work, scratch, { quality: 'balanced', maxIters: 3 });
      writeStableRevision(ctx);
      const committed = { iter: 0, id: 'C1', claim: 'Committed rejection' };
      const stale = { iter: 1, id: 'C2', claim: 'Interrupted rejection' };
      const original = `${JSON.stringify(committed)}\n${JSON.stringify(stale)}\n`;
      const ledger = path.join(work, 'rejected-log.jsonl');
      writeFileSync(ledger, original);
      mkdirSync(temporary);

      expect(() => prepareResume(ctx)).toThrow();
      expect(readFileSync(ledger, 'utf8')).toBe(original);

      rmSync(temporary, { recursive: true });
      expect(prepareResume(ctx)).toBe(1);
      expect(readFileSync(ledger, 'utf8')).toBe(`${JSON.stringify(committed)}\n`);
      expect(
        readdirSync(work)
          .filter((name) => name.startsWith('stale.'))
          .some((archive) => existsSync(path.join(work, archive, 'rejected-log.jsonl'))),
      ).toBe(true);
    } finally {
      rmSync(temporary, { recursive: true, force: true });
      scratch.sweep();
    }
  });
});

describe('resume workdir resolution', () => {
  function makeRun(name: string): string {
    const dir = path.join(tmp, 'plans', name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'plan.v0.md'), '# V0\n');
    return dir;
  }

  it('resolves a single matching workdir', () => {
    const dir = makeRun('loop-feature');
    expect(resolveResumeWorkdir(path.join(tmp, 'plans'), 'feature')).toEqual({
      kind: 'resolved',
      dir,
    });
  });

  it('returns none with guidance when nothing matches', () => {
    mkdirSync(path.join(tmp, 'plans'), { recursive: true });
    const capture = captureStderr();
    try {
      expect(resolveResumeWorkdir(path.join(tmp, 'plans'), 'ghost')).toEqual({ kind: 'none' });
      expect(capture.text()).toContain('resume: no existing workdir with state for ghost');
    } finally {
      capture.restore();
    }
  });

  it('prefers the quality-suffixed directory among ambiguous candidates', () => {
    makeRun('loop-feature');
    const balanced = makeRun('loop-feature-balanced');
    expect(resolveResumeWorkdir(path.join(tmp, 'plans'), 'feature', 'balanced')).toEqual({
      kind: 'resolved',
      dir: balanced,
    });
  });

  it('reports ambiguity without a quality match', () => {
    makeRun('loop-feature');
    makeRun('loop-feature-thorough');
    const capture = captureStderr();
    try {
      expect(resolveResumeWorkdir(path.join(tmp, 'plans'), 'feature')).toEqual({
        kind: 'ambiguous',
      });
      expect(capture.text()).toContain('resume: ambiguous workdir for feature; candidates:');
    } finally {
      capture.restore();
    }
  });
});
