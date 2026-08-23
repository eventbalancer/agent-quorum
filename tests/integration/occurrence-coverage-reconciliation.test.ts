import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
  createReadinessProofCatalog,
  createReadinessProofState,
  projectOccurrenceCoverage,
  recordAdmittedCritique,
  replaceOccurrenceCoverageSnapshot,
  type AdmittedOccurrenceDisposition,
  type OccurrenceCoverageSnapshot,
  type RawOccurrenceDisposition,
  type ReadinessInvariantRecord,
  type ReadinessProofState,
} from '../../src/core/readiness-proof.js';
import { readReadinessProofState } from '../../src/core/readiness-store.js';
import { Scratch } from '../../src/runtime/scratch.js';
import { finalizePlan, type FinalizationResult } from '../../src/stages/plan/finalize.js';
import { fixReviewCandidateDigest, type FixPassOutcome } from '../../src/stages/plan/fix-pass.js';
import { makeTestRunContext } from '../helpers/test-context.js';
import { writeStructuredPlanFile } from '../helpers/harness.js';

const RETAINED_INVARIANT = 'I-v0-C1';
const RETAINED_OCCURRENCE = 'O-72264a0d8aa797239239e8640fae89040611ef052e8867c0de0730205bff59c2';

const roots: string[] = [];
const scratches: Scratch[] = [];

interface Fixture {
  readonly root: string;
  readonly work: string;
  readonly finalPlan: string;
  readonly versionedPlan: string;
  readonly ctx: ReturnType<typeof makeTestRunContext>;
}

function invariantRecords(): readonly ReadinessInvariantRecord[] {
  return [
    {
      id: RETAINED_INVARIANT,
      sourceFinding: 'v0.C1',
      statement: 'Every final projection uses the reconciled occurrence ledger.',
      occurrences: [
        {
          id: RETAINED_OCCURRENCE,
          dimension: 'final-projection',
          subject: 'canonical readiness artifacts',
        },
      ],
    },
  ];
}

function contractFor(state: ReadinessProofState): ReadinessContract {
  return buildReadinessContract({
    assessment: {
      boundary: {
        goal: 'Finalize one exact implementation plan.',
        in_scope: ['fixture plan'],
        out_of_scope: [],
        constraints: ['preserve exact proof identity'],
      },
      domain_assessments: READINESS_RISK_DOMAINS.map((domain) => ({
        domain,
        applicability:
          domain === 'correctness' ? ('applicable' as const) : ('not-applicable' as const),
        risk: 'standard' as const,
        rationale: `${domain} is covered by the fixture boundary.`,
        evidence_refs: [],
      })),
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

function occurrence(disposition: RawOccurrenceDisposition): AdmittedOccurrenceDisposition {
  return {
    invariantId: RETAINED_INVARIANT,
    occurrenceId: RETAINED_OCCURRENCE,
    disposition,
    evidenceGrounded: true,
  };
}

function criticSnapshot(
  state: ReadinessProofState,
  disposition: RawOccurrenceDisposition,
): OccurrenceCoverageSnapshot {
  const slot = state.sources.find((source) => source.source === 'critic');
  if (slot?.requirement.required !== true) {
    throw new TypeError('critic source must be required in the finalization fixture');
  }
  return {
    source: 'critic',
    catalogDigest: state.catalog.digest,
    binding: slot.requirement.expectedBinding,
    occurrences: [occurrence(disposition)],
  };
}

function reviewedProof(
  fixture: Fixture,
  disposition: RawOccurrenceDisposition,
): ReadinessProofState {
  const invariants = invariantRecords();
  const catalog = createReadinessProofCatalog({
    expectedPlanVersion: 0,
    invariants: [{ invariantId: RETAINED_INVARIANT, occurrenceIds: [RETAINED_OCCURRENCE] }],
    materialIssueIds: [],
  });
  let state = createReadinessProofState({
    quality: 'quick',
    matrix: qualityMatrix('quick'),
    mode: 'prompt',
    sourceDigest: '5'.repeat(64),
    authoritativeDigest: fixture.ctx.systemContext.digest,
    relationshipIds: [],
    maxIters: 1,
    trustedCatalog: catalog,
    invariants,
  });
  const contract = contractFor(state);
  state = applyFrozenReadinessContract(state, contract);
  const planSha256 = fileSha256(fixture.versionedPlan);
  const binding = createOccurrenceSourceBinding(state, {
    source: 'critic',
    candidateKind: 'versioned-plan',
    contentDigest: planSha256,
  });
  state = bindVersionedPlan(state, {
    planVersion: 0,
    planSha256,
    criticLineageDigest: binding.lineage.lineageDigest,
  });
  state = recordAdmittedCritique(state, {
    planVersion: 0,
    snapshot: criticSnapshot(state, disposition),
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
  fixture.ctx.readinessProof = state;
  return state;
}

function fixture(title = 'Occurrence Reconciliation'): Fixture {
  const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-finalize-occurrence.'));
  roots.push(root);
  const work = path.join(root, 'work');
  mkdirSync(work);
  const scratch = Scratch.create('finalize-occurrence');
  scratches.push(scratch);
  const finalPlan = path.join(work, 'plan.final.md');
  const versionedPlan = path.join(work, 'plan.v0.md');
  writeStructuredPlanFile(versionedPlan, title);
  copyFileSync(versionedPlan, finalPlan);
  const ctx = makeTestRunContext(root, work, scratch, {
    quality: 'quick',
    mode: 'prompt',
    projectRoot: root,
  });
  return { root, work, finalPlan, versionedPlan, ctx };
}

function exemptFix(): FixPassOutcome {
  return { retainedReplacement: false, requirement: { required: false, reason: 'disabled' } };
}

async function finalize(
  target: Fixture,
  outcome: FixPassOutcome = exemptFix(),
): Promise<FinalizationResult> {
  return finalizePlan(target.ctx, target.finalPlan, outcome);
}

afterEach(() => {
  for (const scratch of scratches.splice(0)) {
    scratch.sweep();
  }
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('canonical occurrence reconciliation during finalization', () => {
  it('removes a stale unresolved occurrence from state, artifact, and public projection', async () => {
    const target = fixture();
    let state = reviewedProof(target, 'unresolved');
    expect(state.occurrenceCoverage.unresolvedOccurrenceIds).toEqual([RETAINED_OCCURRENCE]);
    state = replaceOccurrenceCoverageSnapshot(state, criticSnapshot(state, 'satisfied'));
    target.ctx.readinessProof = state;

    const result = await finalize(target);
    const persisted = readReadinessProofState(path.join(target.work, 'convergence.final.json'));

    expect(result.status).toBe('clean');
    expect(result.projection).toMatchObject({
      status: 'clean',
      readiness: {
        decision: 'ready',
        occurrenceCoverage: {
          resolvedOccurrenceIds: [RETAINED_OCCURRENCE],
          violatedOccurrenceIds: [],
          unresolvedOccurrenceIds: [],
          disagreementOccurrenceIds: [],
          proofSatisfied: true,
        },
      },
      judge: {
        required: false,
        available: false,
        rationale: 'standard-risk-judge-exempt',
      },
    });
    expect(persisted.occurrenceCoverage).toEqual(result.proof.occurrenceCoverage);
    expect(projectOccurrenceCoverage(persisted)).toEqual(
      result.projection.readiness.occurrenceCoverage,
    );
    expect(planStatus(target.finalPlan)).toBe(result.status);
    expect(
      result.proof.sources.find((source) => source.source === 'fix-reviewer')?.requirement,
    ).toEqual({ required: false, reason: 'disabled' });
  });

  it.each([
    ['satisfied', 'resolved', 'clean'],
    ['not-applicable', 'resolved', 'clean'],
    ['violated', 'violated', 'needs-review'],
    ['unresolved', 'unresolved', 'needs-review'],
  ] as const)(
    'preserves %s as %s through exact final projection',
    async (disposition, outcome, expectedStatus) => {
      const target = fixture(`Disposition ${disposition}`);
      reviewedProof(target, disposition);

      const result = await finalize(target);

      expect(result.status).toBe(expectedStatus);
      expect(result.projection.readiness.occurrenceCoverage.outcomes).toEqual([
        { invariantId: RETAINED_INVARIANT, occurrenceId: RETAINED_OCCURRENCE, outcome },
      ]);
      expect(result.projection.readiness.satisfied).toBe(expectedStatus === 'clean');
      expect(planStatus(target.finalPlan)).toBe(result.status);
    },
  );

  it('admits an exact retained fix-reviewer snapshot as a required canonical source', async () => {
    const target = fixture('Before Fix');
    const state = reviewedProof(target, 'satisfied');
    writeStructuredPlanFile(target.finalPlan, 'Reviewed Fix Replacement');
    const contentDigest = fixReviewCandidateDigest(target.finalPlan);
    const binding = createOccurrenceSourceBinding(state, {
      source: 'fix-reviewer',
      candidateKind: 'fix-proposal',
      contentDigest,
    });
    const snapshot: OccurrenceCoverageSnapshot = {
      source: 'fix-reviewer',
      catalogDigest: state.catalog.digest,
      binding,
      occurrences: [occurrence('satisfied')],
    };
    const outcome: FixPassOutcome = {
      retainedReplacement: true,
      candidate: {
        kind: 'fix-proposal',
        planVersion: 0,
        path: target.finalPlan,
        contentDigest,
      },
      requirement: {
        required: true,
        reason: 'fix-pass-replacement-retained',
        expectedBinding: binding,
      },
      review: {
        required: true,
        reason: 'fix-pass-replacement-retained',
        expectedBinding: binding,
        snapshot,
        materialIssueIds: [],
        approval: 'accept',
        concerns: [],
        coverageComplete: true,
        unresolvedOccurrenceIds: [],
        violatedOccurrenceIds: [],
        satisfied: true,
      },
    };

    const result = await finalize(target, outcome);

    expect(result.status).toBe('clean');
    expect(
      result.projection.readiness.occurrenceCoverage.sources.find(
        (source) => source.source === 'fix-reviewer',
      ),
    ).toMatchObject({ required: true, available: true, current: true, conclusive: true });
  });

  it('keeps a stale retained fix-reviewer source required and non-clean', async () => {
    const target = fixture('Before Stale Fix');
    const state = reviewedProof(target, 'satisfied');
    writeStructuredPlanFile(target.finalPlan, 'Stale Fix Candidate');
    const reviewedDigest = fixReviewCandidateDigest(target.finalPlan);
    const binding = createOccurrenceSourceBinding(state, {
      source: 'fix-reviewer',
      candidateKind: 'fix-proposal',
      contentDigest: reviewedDigest,
    });
    const snapshot: OccurrenceCoverageSnapshot = {
      source: 'fix-reviewer',
      catalogDigest: state.catalog.digest,
      binding,
      occurrences: [occurrence('satisfied')],
    };
    writeStructuredPlanFile(target.finalPlan, 'Mutated After Fix Review');
    const outcome: FixPassOutcome = {
      retainedReplacement: true,
      candidate: {
        kind: 'fix-proposal',
        planVersion: 0,
        path: target.finalPlan,
        contentDigest: reviewedDigest,
      },
      requirement: {
        required: true,
        reason: 'fix-pass-replacement-retained',
        expectedBinding: binding,
      },
      review: {
        required: true,
        reason: 'fix-pass-replacement-retained',
        expectedBinding: binding,
        snapshot,
        materialIssueIds: [],
        approval: 'accept',
        concerns: [],
        coverageComplete: true,
        unresolvedOccurrenceIds: [],
        violatedOccurrenceIds: [],
        satisfied: true,
      },
    };

    const result = await finalize(target, outcome);
    const fixSource = result.projection.readiness.occurrenceCoverage.sources.find(
      (source) => source.source === 'fix-reviewer',
    );

    expect(result.status).toBe('needs-review');
    expect(fixSource).toMatchObject({ required: true, available: false, current: false });
    expect(result.projection.readiness.occurrenceCoverage.reasonCodes).toContain(
      'occurrence-source:fix-reviewer:missing',
    );
    expect(planStatus(target.finalPlan)).toBe(result.status);
  });

  it('settles structurally unusable output as blocked with matching frontmatter', async () => {
    const target = fixture('Initially Structured');
    reviewedProof(target, 'satisfied');
    writeFileSync(target.finalPlan, '# Broken Plan\n');

    const result = await finalize(target);

    expect(result).toMatchObject({ status: 'blocked', exitCode: 6 });
    expect(result.projection.structuralStatus).toBe('blocked');
    expect(planStatus(target.finalPlan)).toBe('blocked');
  });
});

function planStatus(file: string): string | undefined {
  return /^status:\s+(clean|needs-review|blocked)\s*$/m.exec(readFileSync(file, 'utf8'))?.[1];
}
