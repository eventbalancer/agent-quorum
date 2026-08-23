import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileSha256 } from '../../src/core/digest.js';
import { qualityMatrix } from '../../src/core/quality.js';
import {
  buildReadinessContract,
  type ReadinessContract,
} from '../../src/core/readiness-contract.js';
import {
  READINESS_RISK_DOMAINS,
  applyFrozenReadinessContract,
  bindVersionedPlan,
  createOccurrenceSourceBinding,
  createReadinessProofState,
  recordAdmittedCritique,
  recordAdmittedJudgeProof,
  reduceReadinessProofState,
  type OccurrenceCoverageSnapshot,
  type ReadinessProofState,
} from '../../src/core/readiness-proof.js';
import type { SystemCheck } from '../../src/core/system-context.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { finalizePlan, type FinalizePlanDependencies } from '../../src/stages/plan/finalize.js';
import type { FinalJudgeResult } from '../../src/stages/plan/judge.js';
import { writeSummary } from '../../src/stages/plan/summary.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import { writeStructuredPlanFile } from '../helpers/harness.js';

const roots: string[] = [];
const scratches: Scratch[] = [];

interface FixtureOptions {
  readonly highRisk?: boolean;
  readonly deterministic?: boolean;
  readonly translate?: boolean;
}

interface Fixture {
  readonly root: string;
  readonly work: string;
  readonly finalPlan: string;
  readonly ctx: ReturnType<typeof makeTestRunContext>;
}

function contractFor(state: ReadinessProofState, options: FixtureOptions): ReadinessContract {
  return buildReadinessContract({
    assessment: {
      boundary: {
        goal: 'Exercise final readiness boundaries.',
        in_scope: ['fixture plan'],
        out_of_scope: [],
        constraints: ['retain exact candidate identity'],
      },
      domain_assessments: READINESS_RISK_DOMAINS.map((domain) => {
        const applicable =
          domain === 'correctness' ||
          (options.deterministic === true && domain === 'cross-repository-delivery');
        return {
          domain,
          applicability: applicable ? ('applicable' as const) : ('not-applicable' as const),
          risk:
            options.highRisk === true && domain === 'correctness'
              ? ('high' as const)
              : ('standard' as const),
          rationale: `${domain} fixture assessment.`,
          evidence_refs: [],
        };
      }),
      material_questions: [],
    },
    sourceDigest: state.sourceDigest,
    systemDigest: state.authoritativeDigest,
    quality: state.quality,
    iterationLimit: state.iterationLimit,
    issueBudget: state.issueBudget.limit,
    operatorDecisionIds: [],
  });
}

function sourceSnapshot(
  state: ReadinessProofState,
  source: 'critic' | 'intermediate-judge',
): OccurrenceCoverageSnapshot {
  const slot = state.sources.find((candidate) => candidate.source === source);
  if (slot?.requirement.required !== true) {
    throw new TypeError(`${source} must be required in the fixture`);
  }
  return {
    source,
    catalogDigest: state.catalog.digest,
    binding: slot.requirement.expectedBinding,
    occurrences: [],
  };
}

function reviewedState(target: Fixture, options: FixtureOptions): ReadinessProofState {
  let state = createReadinessProofState({
    quality: 'balanced',
    matrix: qualityMatrix('balanced'),
    mode: 'prompt',
    sourceDigest: 'a'.repeat(64),
    authoritativeDigest: target.ctx.systemContext.digest,
    relationshipIds: [],
    maxIters: 1,
  });
  const contract = contractFor(state, options);
  state = applyFrozenReadinessContract(state, contract);
  const planSha256 = fileSha256(path.join(target.work, 'plan.v0.md'));
  const criticBinding = createOccurrenceSourceBinding(state, {
    source: 'critic',
    candidateKind: 'versioned-plan',
    contentDigest: planSha256,
  });
  const intermediateBinding =
    options.highRisk === true
      ? createOccurrenceSourceBinding(state, {
          source: 'intermediate-judge',
          candidateKind: 'versioned-plan',
          contentDigest: planSha256,
        })
      : undefined;
  state = bindVersionedPlan(state, {
    planVersion: 0,
    planSha256,
    criticLineageDigest: criticBinding.lineage.lineageDigest,
    ...(intermediateBinding === undefined
      ? {}
      : { intermediateJudgeLineageDigest: intermediateBinding.lineage.lineageDigest }),
  });
  state = recordAdmittedCritique(state, {
    planVersion: 0,
    snapshot: sourceSnapshot(state, 'critic'),
    scanComplete: true,
    declaredScopeVerified: true,
    materialIssueIds: [],
    issueBudgetUsed: 0,
    issueBudgetExhausted: false,
    riskDomains: contract.domainAssessments.map((assessment) => ({
      ...assessment,
      complete: true,
      unavailableEvidence: [],
      lastAssessedPlanVersion: 0,
    })),
    criticCoverageGapIds: [],
    criticScopeCoverageGapIds: [],
    criticContextGapIds: [],
    boundaryChallenges: [],
    opportunities: [],
  });
  if (options.highRisk === true) {
    state = recordAdmittedJudgeProof(state, {
      stage: 'intermediate',
      snapshot: sourceSnapshot(state, 'intermediate-judge'),
      verdict: true,
      approvedPlanVersion: 0,
      materialIssueIds: [],
    });
  }
  target.ctx.readinessProof = state;
  return state;
}

function fixture(options: FixtureOptions = {}): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-finalize-interactions.'));
  roots.push(root);
  const work = path.join(root, 'work');
  mkdirSync(work);
  const scratch = Scratch.create('finalize-interactions');
  scratches.push(scratch);
  const versionedPlan = path.join(work, 'plan.v0.md');
  const finalPlan = path.join(work, 'plan.final.md');
  writeStructuredPlanFile(versionedPlan, 'Readiness Interactions');
  copyFileSync(versionedPlan, finalPlan);
  const ctx = makeTestRunContext(root, work, scratch, {
    quality: 'balanced',
    mode: 'prompt',
    projectRoot: root,
    translatePass: options.translate === true ? 1 : 0,
  });
  const target = { root, work, finalPlan, ctx };
  reviewedState(target, options);
  return target;
}

function exemptFix() {
  return {
    retainedReplacement: false,
    requirement: { required: false, reason: 'disabled' },
  } as const;
}

function judgeResult(
  state: ReadinessProofState,
  finalPlan: string,
  ready: boolean,
  metadataPath: string,
): FinalJudgeResult {
  const binding = createOccurrenceSourceBinding(state, {
    source: 'final-judge',
    candidateKind: 'canonical-plan',
    contentDigest: fileSha256(finalPlan),
  });
  writeFileSync(metadataPath, '{}\n');
  return {
    available: true,
    stage: 'final',
    binding,
    candidateUnchanged: true,
    rationale: ready ? 'ready' : 'not-ready',
    admitted: {
      stage: 'final',
      snapshot: {
        source: 'final-judge',
        catalogDigest: state.catalog.digest,
        binding,
        occurrences: [],
      },
      verdict: ready,
      ...(ready ? { approvedPlanVersion: state.planVersion } : {}),
      materialIssueIds: [],
      rationale: ready ? 'ready' : 'not-ready',
      coverageComplete: true,
      unresolvedOccurrenceIds: [],
      violatedOccurrenceIds: [],
      satisfied: true,
    },
    metadataPath,
  };
}

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    scratch.sweep();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('final readiness responsibility interactions', () => {
  it.each([
    [true, 'clean', 1],
    [false, 'needs-review', 2],
  ] as const)('settles an unchanged final Judge verdict ready=%s', async (ready, status, calls) => {
    const target = fixture({ highRisk: true });
    let judgeCalls = 0;
    const judge: FinalizePlanDependencies['judge'] = (_ctx, state, finalPlan) => {
      judgeCalls += 1;
      return Promise.resolve(
        judgeResult(state, finalPlan, ready, path.join(target.work, 'judge.injected.json')),
      );
    };

    const result = await finalizePlan(target.ctx, target.finalPlan, exemptFix(), { judge });

    expect(result.status).toBe(status);
    expect(result.projection.judge).toMatchObject({
      required: true,
      evaluated: true,
      available: true,
      candidateUnchanged: true,
      verdict: ready,
    });
    expect(judgeCalls).toBe(calls);
    expect(frontmatterStatus(target.finalPlan)).toBe(status);
  });

  it('rejects a returned Judge binding that differs from the admitted snapshot binding', async () => {
    const target = fixture({ highRisk: true });
    const providerSecret = 'MISMATCHED_JUDGE_BINDING_SECRET_71ef65';
    const judge: FinalizePlanDependencies['judge'] = (_ctx, state, finalPlan) => {
      const result = judgeResult(
        state,
        finalPlan,
        true,
        path.join(target.work, 'judge.mismatched-binding.json'),
      );
      if (!result.available) {
        throw new TypeError('fixture Judge result must be available');
      }
      return Promise.resolve({
        ...result,
        rationale: providerSecret,
        binding: {
          ...result.binding,
          lineage: {
            ...result.binding.lineage,
            lineageDigest: 'f'.repeat(64),
          },
        },
        admitted: { ...result.admitted, rationale: providerSecret },
      });
    };

    const result = await finalizePlan(target.ctx, target.finalPlan, exemptFix(), { judge });
    const finalSource = result.projection.readiness.occurrenceCoverage.sources.find(
      (source) => source.source === 'final-judge',
    );

    expect(result.status).toBe('needs-review');
    expect(result.projection.judge).toMatchObject({
      required: true,
      evaluated: true,
      available: false,
      candidateUnchanged: true,
      verdict: null,
      rationale: 'final-judge-proof-unavailable',
    });
    expect(result.projection.judge).not.toHaveProperty('binding');
    expect(finalSource).toMatchObject({ required: true, available: false });
    expect(JSON.stringify(result.projection)).not.toContain(providerSecret);
  });

  it('bounds repeated Judge mutation and leaves the final source stale', async () => {
    const target = fixture({ highRisk: true });
    let judgeCalls = 0;
    const judge: FinalizePlanDependencies['judge'] = (_ctx, state, finalPlan) => {
      judgeCalls += 1;
      const result = judgeResult(
        state,
        finalPlan,
        true,
        path.join(target.work, `judge.mutation.${judgeCalls}.json`),
      );
      appendFileSync(finalPlan, `\nmutation-${judgeCalls}\n`);
      return Promise.resolve({ ...result, candidateUnchanged: false });
    };

    const result = await finalizePlan(target.ctx, target.finalPlan, exemptFix(), { judge });
    const finalSource = result.projection.readiness.occurrenceCoverage.sources.find(
      (source) => source.source === 'final-judge',
    );

    expect(result.status).toBe('needs-review');
    expect(result.projection.judge).toMatchObject({
      required: true,
      available: false,
      candidateUnchanged: false,
      verdict: null,
    });
    expect(finalSource).toMatchObject({ required: true, available: false });
    expect(judgeCalls).toBe(2);
    expect(result.proof.canonicalPlanSha256).toBe(fileSha256(target.finalPlan));
    expect(frontmatterStatus(target.finalPlan)).toBe(result.status);
  });

  it('preserves an observed system-check binding mismatch and cannot clean', async () => {
    const target = fixture({ deterministic: true });
    const systemCheck: FinalizePlanDependencies['systemCheck'] = (_ctx, state) => {
      const check: SystemCheck = {
        schemaVersion: 1,
        planVersion: state.planVersion,
        planSha256: 'observed-wrong-plan-sha',
        systemDigest: state.authoritativeDigest,
        required: true,
        boundaryRepositories: [],
        passed: true,
        crossRepository: false,
        relationships: [],
        mismatches: [],
        requiredEvidenceUnavailable: [],
        limitations: [],
      };
      return check;
    };

    const result = await finalizePlan(target.ctx, target.finalPlan, exemptFix(), {
      systemCheck,
    });
    const persisted = JSON.parse(
      readFileSync(path.join(target.work, 'system-check.final.json'), 'utf8'),
    ) as SystemCheck;

    expect(result.status).toBe('needs-review');
    expect(result.projection.readiness).toMatchObject({
      decision: 'unable-to-decide',
      reasonCodes: ['required-evidence-unavailable'],
    });
    expect(result.proof.systemMismatchIds).toContain('system-check:binding-mismatch');
    expect(persisted).toMatchObject({
      planVersion: result.proof.planVersion,
      planSha256: result.proof.canonicalPlanSha256,
      systemDigest: result.proof.authoritativeDigest,
      passed: false,
      mismatches: ['system-check:binding-mismatch', 'system-check:semantic-mismatch'],
    });
    expect(frontmatterStatus(target.finalPlan)).toBe(result.status);
  });

  it('projects an explicit unavailable Judge when the system check mutates the candidate', async () => {
    const target = fixture({ highRisk: true });
    let systemCheckCalls = 0;
    const systemCheck: FinalizePlanDependencies['systemCheck'] = (_ctx, state, finalPlan) => {
      systemCheckCalls += 1;
      const check: SystemCheck = {
        schemaVersion: 1,
        planVersion: state.planVersion,
        planSha256: fileSha256(finalPlan),
        systemDigest: state.authoritativeDigest,
        required: false,
        boundaryRepositories: [],
        passed: true,
        crossRepository: false,
        relationships: [],
        mismatches: [],
        requiredEvidenceUnavailable: [],
        limitations: [],
      };
      if (systemCheckCalls <= 2) {
        appendFileSync(finalPlan, `\nsystem-check-mutation-${systemCheckCalls}\n`);
      }
      return check;
    };

    const result = await finalizePlan(target.ctx, target.finalPlan, exemptFix(), {
      systemCheck,
    });

    expect(result.status).toBe('needs-review');
    expect(result.projection.judge).toMatchObject({
      required: true,
      evaluated: false,
      available: false,
      candidateUnchanged: false,
      verdict: null,
      rationale: 'final-candidate-mutated-during-system-check',
    });
    expect(result.projection.judge).not.toHaveProperty('binding');
    expect(systemCheckCalls).toBeGreaterThanOrEqual(2);
    expect(frontmatterStatus(target.finalPlan)).toBe(result.status);
  });

  it('rejects jointly mutated versioned and canonical bytes as independently reviewed', async () => {
    const target = fixture();
    const reviewedSha256 = target.ctx.readinessProof.planSha256;
    const mutation = '\nUnreviewed joint mutation.\n';
    appendFileSync(path.join(target.work, 'plan.v0.md'), mutation);
    appendFileSync(target.finalPlan, mutation);

    const result = await finalizePlan(target.ctx, target.finalPlan, exemptFix());

    expect(result.status).toBe('needs-review');
    expect(result.proof.planSha256).toBe(reviewedSha256);
    expect(result.proof.canonicalPlanSha256).toBe(fileSha256(target.finalPlan));
    expect(result.proof.reduction.satisfied).toBe(false);
    expect(result.projection.readiness.reasonCodes).toEqual(
      expect.arrayContaining(['canonical-plan-binding-mismatch', 'fresh-review-required']),
    );
    expect(frontmatterStatus(target.finalPlan)).toBe(result.status);
  });

  it('keeps provider unavailable-evidence text out of projection and summary', async () => {
    const target = fixture();
    const secret = 'FINAL_UNAVAILABLE_EVIDENCE_SECRET_7cf152';
    target.ctx.readinessProof = reduceReadinessProofState({
      ...target.ctx.readinessProof,
      riskDomains: target.ctx.readinessProof.riskDomains.map((assessment) =>
        assessment.domain === 'correctness'
          ? { ...assessment, unavailableEvidence: [secret] }
          : assessment,
      ),
    });

    const result = await finalizePlan(target.ctx, target.finalPlan, exemptFix());
    writeSummary(target.ctx, {
      iter: 0,
      localizedFinalFile: path.join(target.work, 'plan.final.localized.md'),
      finalStale: 0,
      finalAmbiguous: 0,
      finalUnresolved: 0,
      final: result.projection,
      splitDecision: 'single-plan',
      splitRationale: 'fixture',
      packagePhaseCount: 0,
    });

    expect(JSON.stringify(result.proof.riskDomains)).toContain(secret);
    expect(JSON.stringify(result.projection)).not.toContain(secret);
    expect(result.projection.readiness.unresolvedProofIds).toContainEqual(
      expect.stringMatching(
        /^plan\.v0:required-evidence:domain-evidence-unavailable-[a-f0-9]{64}$/,
      ),
    );
    expect(readFileSync(path.join(target.work, 'summary.md'), 'utf8')).not.toContain(secret);
  });

  it('rejects a system check that weakens the trusted deterministic-proof requirement', async () => {
    const target = fixture({ deterministic: true });
    const systemCheck: FinalizePlanDependencies['systemCheck'] = (_ctx, state, finalPlan) => ({
      schemaVersion: 1,
      planVersion: state.planVersion,
      planSha256: fileSha256(finalPlan),
      systemDigest: state.authoritativeDigest,
      required: false,
      boundaryRepositories: [],
      passed: true,
      crossRepository: false,
      relationships: [],
      mismatches: [],
      requiredEvidenceUnavailable: [],
      limitations: [],
    });

    const result = await finalizePlan(target.ctx, target.finalPlan, exemptFix(), {
      systemCheck,
    });
    const persisted = JSON.parse(
      readFileSync(path.join(target.work, 'system-check.final.json'), 'utf8'),
    ) as SystemCheck;

    expect(result.status).toBe('needs-review');
    expect(result.proof.systemCheckPassed).toBe(false);
    expect(result.proof.systemMismatchIds).toEqual(
      expect.arrayContaining([
        'system-check:requirement-mismatch',
        'system-check:semantic-mismatch',
      ]),
    );
    expect(result.proof.reduction.satisfied).toBe(false);
    expect(persisted).toMatchObject({
      planVersion: result.proof.planVersion,
      planSha256: result.proof.canonicalPlanSha256,
      systemDigest: result.proof.authoritativeDigest,
      required: true,
      passed: false,
      mismatches: ['system-check:requirement-mismatch', 'system-check:semantic-mismatch'],
    });
    expect(frontmatterStatus(target.finalPlan)).toBe(result.status);
  });

  it('detects localization mutation, rebinds deterministic proof, and stays non-clean', async () => {
    const target = fixture({ highRisk: true, translate: true });
    const judge: FinalizePlanDependencies['judge'] = (_ctx, state, finalPlan) =>
      Promise.resolve(
        judgeResult(state, finalPlan, true, path.join(target.work, 'judge.pre-localization.json')),
      );
    const localize: FinalizePlanDependencies['localize'] = (_ctx, finalPlan, outFile) => {
      writeFileSync(outFile, readFileSync(finalPlan));
      appendFileSync(finalPlan, '\nlocalization-mutated-canonical\n');
    };

    const result = await finalizePlan(target.ctx, target.finalPlan, exemptFix(), {
      judge,
      localize,
    });

    expect(result.status).toBe('needs-review');
    expect(result.proof.canonicalPlanSha256).toBe(fileSha256(target.finalPlan));
    expect(result.projection.readiness.reasonCodes).toContain('canonical-plan-binding-mismatch');
    expect(result.projection.judge).toMatchObject({
      required: true,
      available: false,
      candidateUnchanged: false,
      verdict: null,
    });
    expect(result.projection.judge).not.toHaveProperty('binding');
    expect(frontmatterStatus(target.finalPlan)).toBe(result.status);
  });
});

function frontmatterStatus(file: string): string | undefined {
  return /^status:\s+(clean|needs-review|blocked)\s*$/m.exec(readFileSync(file, 'utf8'))?.[1];
}
