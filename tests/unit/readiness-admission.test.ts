import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ReadinessAdmissionError,
  admitCreatorUpdate,
  admitCritique,
  admitFixReviewer,
  admitJudge,
  type ReadinessAdmissionCode,
} from '../../src/core/readiness-admission.js';
import { sha256, stableTupleId } from '../../src/core/digest.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../../src/core/json.js';
import { RETAINED_CONTEXT_CATEGORIES, RISK_DOMAINS } from '../../src/core/readiness-contract.js';
import {
  createReadinessProofCatalog,
  type OccurrenceSource,
  type OccurrenceSourceBinding,
  type ReadinessProofCatalog,
  type ReadinessRiskDomainRecord,
} from '../../src/core/readiness-proof.js';

const CANDIDATE_CONTENT = '# Candidate\n\n## Evidence\n\nRun `pnpm run check`.\n';
const GROUNDED_EVIDENCE = [{ kind: 'plan-section', section: 'Evidence' }];

function catalog(planVersion = 2): ReadinessProofCatalog {
  return createReadinessProofCatalog({
    expectedPlanVersion: planVersion,
    invariants: [
      { invariantId: 'I1', occurrenceIds: ['O1', 'O2'] },
      { invariantId: 'I2', occurrenceIds: ['O3', 'O4'] },
    ],
    materialIssueIds: [],
  });
}

function emptyCatalog(planVersion = 2): ReadinessProofCatalog {
  return createReadinessProofCatalog({
    expectedPlanVersion: planVersion,
    invariants: [],
    materialIssueIds: [],
  });
}

function binding(source: OccurrenceSource, planVersion = 2): OccurrenceSourceBinding {
  const contentDigest = sha256(CANDIDATE_CONTENT);
  if (source === 'critic') {
    return {
      candidate: { kind: 'versioned-plan', planVersion, contentDigest },
      lineage: { evaluationStage: 'review', lineageDigest: 'critic-lineage' },
    };
  }
  if (source === 'fix-reviewer') {
    return {
      candidate: { kind: 'fix-proposal', planVersion, contentDigest },
      lineage: { evaluationStage: 'fix-proposal-review', lineageDigest: 'review-lineage' },
    };
  }
  if (source === 'intermediate-judge') {
    return {
      candidate: { kind: 'versioned-plan', planVersion, contentDigest },
      lineage: {
        evaluationStage: 'intermediate-readiness',
        lineageDigest: 'intermediate-lineage',
      },
    };
  }
  return {
    candidate: { kind: 'canonical-plan', planVersion, contentDigest },
    lineage: { evaluationStage: 'final-readiness', lineageDigest: 'final-lineage' },
  };
}

function evidenceContext(planVersion = 2) {
  return {
    work: '/tmp/agent-quorum-admission-work',
    projectRoot: '/tmp/agent-quorum-admission-project',
    planVersion,
    candidateContent: CANDIDATE_CONTENT,
  };
}

function currentRiskDomains(): ReadinessRiskDomainRecord[] {
  return RISK_DOMAINS.map((domain) => ({
    domain,
    applicability: domain === 'correctness' ? 'applicable' : 'unknown',
    risk: domain === 'correctness' ? 'high' : 'standard',
    rationale: `Frozen ${domain}`,
    evidenceRefs: [],
    complete: false,
    unavailableEvidence: [],
  }));
}

function occurrence(
  occurrenceId: string,
  disposition: 'satisfied' | 'violated' | 'not-applicable' | 'unresolved' = 'satisfied',
): JsonObject {
  return {
    occurrence_id: occurrenceId,
    disposition,
    evidence_refs: disposition === 'unresolved' ? [] : GROUNDED_EVIDENCE,
  };
}

function invariantAssessments(
  dispositions: Readonly<
    Record<string, 'satisfied' | 'violated' | 'not-applicable' | 'unresolved'>
  > = {},
  includeComplete = false,
): JsonValue[] {
  return [
    {
      invariant_id: 'I1',
      ...(includeComplete ? { complete: true } : {}),
      occurrences: [occurrence('O1', dispositions.O1), occurrence('O2', dispositions.O2)],
    },
    {
      invariant_id: 'I2',
      ...(includeComplete ? { complete: true } : {}),
      occurrences: [occurrence('O3', dispositions.O3), occurrence('O4', dispositions.O4)],
    },
  ];
}

function critiqueFixture(): JsonObject {
  return {
    plan_version: 2,
    summary: 'One material issue remains.',
    review: {
      considered_context: [...RETAINED_CONTEXT_CATEGORIES],
      invariant_assessments: invariantAssessments(
        {
          O1: 'satisfied',
          O2: 'not-applicable',
          O3: 'violated',
          O4: 'unresolved',
        },
        true,
      ),
      scope_coverage: ['original-scope'],
      issue_budget: { limit: 8, used: 1, exhausted: false },
      scan_complete: true,
      unresolved_coverage: [],
    },
    domain_assessments: RISK_DOMAINS.map((domain) => ({
      domain,
      applicability: 'applicable',
      risk: domain === 'correctness' ? 'high' : 'standard',
      complete: true,
      rationale: `Current ${domain}`,
      unavailable_evidence: [],
      evidence_refs: GROUNDED_EVIDENCE,
    })),
    boundary_challenges: [
      {
        id: 'B1',
        kind: 'scope-expansion',
        claim: 'The frozen scope may need expansion.',
        rationale: 'The required change is outside the boundary.',
        evidence: '## Evidence',
        evidence_refs: GROUNDED_EVIDENCE,
      },
    ],
    opportunities: [
      {
        fingerprint: 'optional-heading',
        claim: 'The heading could be clearer.',
        evidence: '## Evidence',
        suggested_improvement: 'Rename the heading.',
        evidence_refs: GROUNDED_EVIDENCE,
      },
    ],
    issues: [
      {
        id: 'C1',
        addresses: null,
        severity: 'major',
        category: 'correctness',
        claim: 'The plan omits a required check.',
        evidence: '## Evidence',
        evidence_refs: GROUNDED_EVIDENCE,
        suggested_fix: 'Add the required check.',
        confidence: 1,
        duplicate_of: null,
      },
    ],
  };
}

function reviewerFixture(
  dispositions: Readonly<
    Record<string, 'satisfied' | 'violated' | 'not-applicable' | 'unresolved'>
  > = {},
): JsonObject {
  const unresolved = Object.entries(dispositions)
    .filter(([, disposition]) => disposition === 'unresolved')
    .map(([id]) => id);
  return {
    approval: 'accept',
    coverage_complete: true,
    unresolved_occurrence_ids: unresolved,
    invariant_assessments: invariantAssessments(dispositions),
    concerns: [],
  };
}

function judgeFixture(
  ready: boolean,
  dispositions: Readonly<
    Record<string, 'satisfied' | 'violated' | 'not-applicable' | 'unresolved'>
  > = {},
): JsonObject {
  const unresolved = Object.entries(dispositions)
    .filter(([, disposition]) => disposition === 'unresolved')
    .map(([id]) => id);
  return {
    ready,
    rationale: ready ? 'The candidate is ready.' : 'The candidate needs more work.',
    revision_issue: null,
    coverage_complete: true,
    unresolved_occurrence_ids: unresolved,
    invariant_assessments: invariantAssessments(dispositions),
  };
}

function clone(value: JsonObject): JsonObject {
  const cloned = structuredClone(value) as JsonValue;
  if (!isJsonObject(cloned)) {
    throw new Error('fixture must clone to an object');
  }
  return cloned;
}

function objectAt(value: JsonValue | undefined, label: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function objectArrayAt(value: JsonValue | undefined, label: string): JsonObject[] {
  if (!Array.isArray(value) || !value.every(isJsonObject)) {
    throw new Error(`${label} must be an object array`);
  }
  return value;
}

function objectEntryAt(value: JsonValue | undefined, index: number, label: string): JsonObject {
  const entry = objectArrayAt(value, label)[index];
  if (entry === undefined) {
    throw new Error(`${label}[${index}] must exist`);
  }
  return entry;
}

function expectCode(action: () => unknown, code: ReadinessAdmissionCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(ReadinessAdmissionError);
    expect((error as ReadinessAdmissionError).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code} admission rejection`);
}

function admitCriticFixture(value: JsonValue) {
  return admitCritique({
    value,
    catalog: catalog(),
    binding: binding('critic'),
    evidenceContext: evidenceContext(),
    expectedScopeToken: 'original-scope',
    issueBudgetLimit: 8,
    currentRiskDomains: currentRiskDomains(),
    admittedPriorIssueRefs: ['v1.C1'],
  });
}

describe('critic semantic admission', () => {
  it('normalizes exact current facts and preserves all four occurrence dispositions', () => {
    const admitted = admitCriticFixture(critiqueFixture());

    expect(admitted.snapshot).toMatchObject({
      source: 'critic',
      catalogDigest: catalog().digest,
      binding: binding('critic'),
    });
    expect(admitted.snapshot.occurrences).toEqual([
      { invariantId: 'I1', occurrenceId: 'O1', disposition: 'satisfied', evidenceGrounded: true },
      {
        invariantId: 'I1',
        occurrenceId: 'O2',
        disposition: 'not-applicable',
        evidenceGrounded: true,
      },
      { invariantId: 'I2', occurrenceId: 'O3', disposition: 'violated', evidenceGrounded: true },
      { invariantId: 'I2', occurrenceId: 'O4', disposition: 'unresolved', evidenceGrounded: false },
    ]);
    expect(admitted.materialIssueIds).toEqual(['v2.C1']);
    expect(admitted.materialIssues[0]).toMatchObject({ id: 'C1', severity: 'major' });
    expect(admitted.boundaryChallenges).toHaveLength(1);
    expect(admitted.opportunities).toHaveLength(1);
    expect(admitted.scanComplete).toBe(true);
    expect(admitted.declaredScopeVerified).toBe(true);
    expect(admitted.riskDomains.find((domain) => domain.domain === 'correctness')).toMatchObject({
      applicability: 'applicable',
      risk: 'high',
      complete: true,
      lastAssessedPlanVersion: 2,
    });
  });

  it.each(['v2.C1', 'v99.C1'])('rejects provider-versioned issue identity %s', (issueId) => {
    const value = critiqueFixture();
    objectEntryAt(value.issues, 0, 'issues').id = issueId;

    expectCode(() => admitCriticFixture(value), 'invalid-value');
  });

  it.each([
    ['future parent issue', 'addresses', 'v99.C1', 'plan-version-mismatch'],
    ['unknown parent issue', 'addresses', 'v1.C9', 'unknown-identity'],
    ['unknown invariant', 'invariant_id', 'I-unknown', 'unknown-identity'],
    [
      'wrong introducing revision',
      'introduced_by_revision',
      'plan.v99.md',
      'plan-version-mismatch',
    ],
  ] as const)('rejects %s before proof admission', (_label, field, value, code) => {
    const critique = critiqueFixture();
    objectEntryAt(critique.issues, 0, 'issues')[field] = value;

    expectCode(() => admitCriticFixture(critique), code);
  });

  it('does not trust a forged prior critique file as admitted issue lineage', () => {
    const work = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-admission-lineage.'));
    try {
      writeFileSync(
        path.join(work, 'critique.v1.json'),
        `${JSON.stringify({ plan_version: 1, issues: [{ id: 'C9' }] })}\n`,
      );
      const critique = critiqueFixture();
      objectEntryAt(critique.issues, 0, 'issues').addresses = 'v1.C9';

      expectCode(
        () =>
          admitCritique({
            value: critique,
            catalog: catalog(),
            binding: binding('critic'),
            evidenceContext: { ...evidenceContext(), work },
            expectedScopeToken: 'original-scope',
            issueBudgetLimit: 8,
            currentRiskDomains: currentRiskDomains(),
            admittedPriorIssueRefs: ['v1.C1'],
          }),
        'unknown-identity',
      );
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it.each([
    [
      'omitted invariant',
      (value: JsonObject) => {
        objectArrayAt(objectAt(value.review, 'review').invariant_assessments, 'assessments').pop();
      },
      'missing-identity',
    ],
    [
      'duplicate invariant',
      (value: JsonObject) => {
        const assessments = objectArrayAt(
          objectAt(value.review, 'review').invariant_assessments,
          'assessments',
        );
        assessments.push(clone(assessments[0] ?? {}));
      },
      'duplicate-identity',
    ],
    [
      'unknown invariant',
      (value: JsonObject) => {
        objectEntryAt(
          objectAt(value.review, 'review').invariant_assessments,
          0,
          'assessments',
        ).invariant_id = 'I-unknown';
      },
      'unknown-identity',
    ],
    [
      'omitted occurrence',
      (value: JsonObject) => {
        const first = objectArrayAt(
          objectAt(value.review, 'review').invariant_assessments,
          'assessments',
        )[0];
        objectArrayAt(first?.occurrences, 'occurrences').pop();
      },
      'missing-identity',
    ],
    [
      'duplicate occurrence',
      (value: JsonObject) => {
        const first = objectArrayAt(
          objectAt(value.review, 'review').invariant_assessments,
          'assessments',
        )[0];
        const occurrences = objectArrayAt(first?.occurrences, 'occurrences');
        occurrences.push(clone(occurrences[0] ?? {}));
      },
      'duplicate-identity',
    ],
    [
      'unknown occurrence',
      (value: JsonObject) => {
        const first = objectArrayAt(
          objectAt(value.review, 'review').invariant_assessments,
          'assessments',
        )[0];
        objectEntryAt(first?.occurrences, 0, 'occurrences').occurrence_id = 'O-unknown';
      },
      'unknown-identity',
    ],
    [
      'cross-invariant occurrence',
      (value: JsonObject) => {
        const first = objectArrayAt(
          objectAt(value.review, 'review').invariant_assessments,
          'assessments',
        )[0];
        objectEntryAt(first?.occurrences, 0, 'occurrences').occurrence_id = 'O3';
      },
      'cross-invariant',
    ],
    [
      'duplicate risk domain',
      (value: JsonObject) => {
        const domains = objectArrayAt(value.domain_assessments, 'domains');
        objectEntryAt(domains, 7, 'domains').domain =
          objectEntryAt(domains, 0, 'domains').domain ?? null;
      },
      'duplicate-identity',
    ],
    [
      'unknown risk domain',
      (value: JsonObject) => {
        objectEntryAt(value.domain_assessments, 0, 'domains').domain = 'unknown-domain';
      },
      'unknown-identity',
    ],
    [
      'ungrounded complete risk domains',
      (value: JsonObject) => {
        for (const assessment of objectArrayAt(value.domain_assessments, 'domains')) {
          assessment.evidence_refs = [];
        }
      },
      'ungrounded-evidence',
    ],
    [
      'ungrounded not-applicable risk domains',
      (value: JsonObject) => {
        const assessment = objectEntryAt(value.domain_assessments, 1, 'domains');
        assessment.applicability = 'not-applicable';
        assessment.complete = false;
        assessment.evidence_refs = [];
      },
      'ungrounded-evidence',
    ],
    [
      'complete unknown risk domain',
      (value: JsonObject) => {
        const assessment = objectEntryAt(value.domain_assessments, 1, 'domains');
        assessment.applicability = 'unknown';
        assessment.complete = true;
      },
      'summary-mismatch',
    ],
    [
      'frozen applicable-domain downgrade',
      (value: JsonObject) => {
        objectEntryAt(value.domain_assessments, 0, 'domains').applicability = 'not-applicable';
      },
      'summary-mismatch',
    ],
    [
      'frozen high-risk downgrade',
      (value: JsonObject) => {
        objectEntryAt(value.domain_assessments, 0, 'domains').risk = 'standard';
      },
      'summary-mismatch',
    ],
    [
      'ungrounded material issue',
      (value: JsonObject) => {
        objectEntryAt(value.issues, 0, 'issues').evidence_refs = [];
      },
      'ungrounded-evidence',
    ],
    [
      'ungrounded boundary challenge',
      (value: JsonObject) => {
        objectEntryAt(value.boundary_challenges, 0, 'boundary_challenges').evidence_refs = [];
      },
      'ungrounded-evidence',
    ],
    [
      'ungrounded opportunity',
      (value: JsonObject) => {
        objectEntryAt(value.opportunities, 0, 'opportunities').evidence_refs = [];
      },
      'ungrounded-evidence',
    ],
    [
      'missing retained category',
      (value: JsonObject) => {
        const review = objectAt(value.review, 'review');
        if (!Array.isArray(review.considered_context)) {
          throw new Error('considered_context must be an array');
        }
        review.considered_context.pop();
      },
      'missing-identity',
    ],
    [
      'duplicate retained category',
      (value: JsonObject) => {
        const review = objectAt(value.review, 'review');
        if (!Array.isArray(review.considered_context)) {
          throw new Error('considered_context must be an array');
        }
        review.considered_context.push(review.considered_context[0] ?? null);
      },
      'duplicate-identity',
    ],
    [
      'unknown retained category',
      (value: JsonObject) => {
        const review = objectAt(value.review, 'review');
        if (!Array.isArray(review.considered_context)) {
          throw new Error('considered_context must be an array');
        }
        review.considered_context[0] = 'unknown-context';
      },
      'unknown-identity',
    ],
    [
      'wrong scope token',
      (value: JsonObject) => {
        objectAt(value.review, 'review').scope_coverage = ['direct-plan-scope'];
      },
      'missing-identity',
    ],
    [
      'unknown scope token',
      (value: JsonObject) => {
        objectAt(value.review, 'review').scope_coverage = ['original-scope', 'unknown-scope'];
      },
      'unknown-identity',
    ],
  ] as const)('rejects %s', (_label, mutate, code) => {
    const value = clone(critiqueFixture());
    mutate(value);
    expectCode(() => admitCriticFixture(value), code);
  });

  it.each(['satisfied', 'violated', 'not-applicable'] as const)(
    'rejects ungrounded %s evidence',
    (disposition) => {
      const value = clone(critiqueFixture());
      const first = objectArrayAt(
        objectAt(value.review, 'review').invariant_assessments,
        'assessments',
      )[0];
      const firstOccurrence = objectArrayAt(first?.occurrences, 'occurrences')[0];
      if (firstOccurrence === undefined) {
        throw new Error('first occurrence must exist');
      }
      firstOccurrence.disposition = disposition;
      firstOccurrence.evidence_refs = [];

      expectCode(() => admitCriticFixture(value), 'ungrounded-evidence');
    },
  );

  it('rejects a cross-plan critique before admitting its facts', () => {
    const value = clone(critiqueFixture());
    value.plan_version = 3;
    value.review = null;

    expectCode(() => admitCriticFixture(value), 'plan-version-mismatch');
  });

  it('rejects a candidate binding whose digest does not match the admitted bytes', () => {
    expectCode(
      () =>
        admitCritique({
          value: critiqueFixture(),
          catalog: catalog(),
          binding: {
            ...binding('critic'),
            candidate: { ...binding('critic').candidate, contentDigest: 'stale-digest' },
          },
          evidenceContext: evidenceContext(),
          expectedScopeToken: 'original-scope',
          issueBudgetLimit: 8,
          currentRiskDomains: currentRiskDomains(),
          admittedPriorIssueRefs: ['v1.C1'],
        }),
      'binding-mismatch',
    );
  });

  it('rejects a binding from a stale evaluation stage', () => {
    expectCode(
      () =>
        admitCritique({
          value: critiqueFixture(),
          catalog: catalog(),
          binding: {
            ...binding('critic'),
            lineage: {
              ...binding('critic').lineage,
              evaluationStage: 'final-readiness',
            },
          },
          evidenceContext: evidenceContext(),
          expectedScopeToken: 'original-scope',
          issueBudgetLimit: 8,
          currentRiskDomains: currentRiskDomains(),
          admittedPriorIssueRefs: ['v1.C1'],
        }),
      'binding-mismatch',
    );
  });

  it('accepts multiple known scope tokens when the expected token is present', () => {
    const value = clone(critiqueFixture());
    objectAt(value.review, 'review').scope_coverage = ['declared-scope', 'direct-plan-scope'];

    const admitted = admitCritique({
      value,
      catalog: catalog(),
      binding: binding('critic'),
      evidenceContext: evidenceContext(),
      expectedScopeToken: 'declared-scope',
      issueBudgetLimit: 8,
      currentRiskDomains: currentRiskDomains(),
      admittedPriorIssueRefs: ['v1.C1'],
    });

    expect(admitted.declaredScopeVerified).toBe(true);
  });

  it('keeps a proved scan complete when the independent issue budget is exhausted', () => {
    const value = clone(critiqueFixture());
    objectAt(objectAt(value.review, 'review').issue_budget, 'issue_budget').exhausted = true;

    const admitted = admitCriticFixture(value);

    expect(admitted.scanComplete).toBe(true);
    expect(admitted.issueBudgetExhausted).toBe(true);
  });
});

function creatorFixture(): JsonObject {
  return {
    plan_version: 3,
    issues: [
      {
        id: 'C1',
        verdict: 'accept',
        verdict_reason: 'The evidence is confirmed.',
        final_severity: 'major',
        duplicate_of: null,
      },
      {
        id: 'C2',
        verdict: 'downgrade',
        verdict_reason: 'The issue remains material but is not blocking.',
        final_severity: 'major',
        duplicate_of: null,
      },
    ],
    applied: ['C1', 'C2'],
    systemic_dispositions: [
      {
        issue_id: 'C1',
        scope: 'local',
        rationale: 'The revision adds the missing local check.',
        evidence_refs: GROUNDED_EVIDENCE,
        superseded_by: null,
        invariant: null,
      },
      {
        issue_id: 'C2',
        scope: 'cross-cutting',
        rationale: 'The revision creates a retained compatibility invariant.',
        evidence_refs: GROUNDED_EVIDENCE,
        superseded_by: null,
        invariant: {
          statement: 'Every consumer retains compatible output.',
          occurrences: [
            { dimension: 'consumer', subject: 'CLI' },
            { dimension: 'consumer', subject: 'library' },
          ],
        },
      },
    ],
    rejected_append: [],
  };
}

function admitCreatorFixture(
  value: JsonValue,
  options: {
    readonly secondIssueProvenance?: 'critic' | 'intermediate-judge';
    readonly judgeRevisionIssueIds?: readonly string[];
  } = {},
) {
  const secondIssue = {
    id: 'C2',
    severity: 'blocker' as const,
    claim: 'Compatibility is not preserved.',
    evidence: 'The public projection changes incompatibly.',
    suggestedFix: 'Retain compatible output.',
    provenance: options.secondIssueProvenance ?? ('critic' as const),
  };
  return admitCreatorUpdate({
    value,
    currentCatalog: emptyCatalog(2),
    fromPlanVersion: 2,
    expectedPlanVersion: 3,
    expectedIssues: [
      {
        id: 'C1',
        severity: 'major',
        claim: 'The plan omits a required check.',
        evidence: 'The implementation checklist omits the check.',
        suggestedFix: 'Add the missing check.',
        provenance: 'critic',
      },
      secondIssue,
    ],
    retainedFindings: [],
    retainedInvariants: [],
    evidenceContext: evidenceContext(3),
    operatorInterventionIds: [],
    admittedCriticIssueRefs: secondIssue.provenance === 'critic' ? ['v2.C1', 'v2.C2'] : ['v2.C1'],
    admittedJudgeRevisionIssueIds:
      options.judgeRevisionIssueIds ??
      (secondIssue.provenance === 'intermediate-judge'
        ? [
            stableTupleId('judge-revision', [
              2,
              secondIssue.claim,
              secondIssue.evidence,
              secondIssue.suggestedFix,
            ]),
          ]
        : []),
  });
}

describe('creator-update semantic admission', () => {
  it('validates exact verdict/disposition coverage and builds the next trusted catalog', () => {
    const raw = creatorFixture();
    const before = structuredClone(raw);
    const admitted = admitCreatorFixture(raw);

    expect(raw).toEqual(before);
    expect(admitted.fromPlanVersion).toBe(2);
    expect(admitted.verdicts).toEqual([
      {
        id: 'C1',
        verdict: 'accept',
        verdictReason: 'The evidence is confirmed.',
        finalSeverity: 'major',
        duplicateOf: null,
      },
      {
        id: 'C2',
        verdict: 'downgrade',
        verdictReason: 'The issue remains material but is not blocking.',
        finalSeverity: 'major',
        duplicateOf: null,
      },
    ]);
    expect(admitted.findings.map((finding) => finding.id)).toEqual(['I-v2-C1', 'I-v2-C2']);
    expect(admitted.invariants).toEqual([
      expect.objectContaining({
        id: 'I-v2-C2',
        sourceFinding: 'I-v2-C2',
        occurrences: [
          expect.objectContaining({ dimension: 'consumer', subject: 'CLI' }),
          expect.objectContaining({ dimension: 'consumer', subject: 'library' }),
        ],
      }),
    ]);
    expect(admitted.nextCatalog).toMatchObject({
      expectedPlanVersion: 3,
      materialIssueIds: ['I-v2-C1', 'I-v2-C2'],
      invariants: [expect.objectContaining({ invariantId: 'I-v2-C2' })],
    });
    expect(admitted.materialRevisionProofGapIds).toEqual([]);
  });

  it('validates provider plan_version before touching malformed verdict data', () => {
    const value = clone(creatorFixture());
    value.plan_version = 4;
    value.issues = null;

    expectCode(() => admitCreatorFixture(value), 'plan-version-mismatch');
  });

  it('authenticates an intermediate-Judge revision against its exact admitted identity', () => {
    expect(
      admitCreatorFixture(creatorFixture(), { secondIssueProvenance: 'intermediate-judge' })
        .transitionReceipt,
    ).toBeDefined();
    expectCode(
      () =>
        admitCreatorFixture(creatorFixture(), {
          secondIssueProvenance: 'intermediate-judge',
          judgeRevisionIssueIds: ['judge-revision-forged'],
        }),
      'catalog-mismatch',
    );
  });

  it('still requires a systemic disposition when a material issue is downgraded to minor', () => {
    const value = clone(creatorFixture());
    objectEntryAt(value.issues, 1, 'issues').final_severity = 'minor';
    objectArrayAt(value.systemic_dispositions, 'dispositions').pop();

    expectCode(() => admitCreatorFixture(value), 'missing-identity');
  });

  it.each([
    [
      'duplicate verdict lineage',
      (value: JsonObject) => {
        const verdict = objectEntryAt(value.issues, 0, 'issues');
        verdict.verdict = 'duplicate_of_prior';
        verdict.duplicate_of = 'forged-rejected-entry';
        value.applied = ['C2'];
        objectArrayAt(value.systemic_dispositions, 'dispositions').shift();
      },
      'invalid-value',
    ],
    [
      'non-null reserved duplicate identity',
      (value: JsonObject) => {
        objectEntryAt(value.issues, 0, 'issues').duplicate_of = 'forged-rejected-entry';
      },
      'invalid-value',
    ],
    [
      'blank verdict reason',
      (value: JsonObject) => {
        objectEntryAt(value.issues, 0, 'issues').verdict_reason = '';
      },
      'invalid-value',
    ],
    [
      'accepted severity rewrite',
      (value: JsonObject) => {
        objectEntryAt(value.issues, 0, 'issues').final_severity = 'minor';
      },
      'summary-mismatch',
    ],
    [
      'invented rejected ledger entry',
      (value: JsonObject) => {
        value.rejected_append = [
          { id: 'C99', claim: 'Forged prior rejection.', reason: 'not_value_adding' },
        ];
      },
      'unknown-identity',
    ],
  ] as const)('rejects %s before creator proof admission', (_label, mutate, code) => {
    const value = clone(creatorFixture());
    mutate(value);

    expectCode(() => admitCreatorFixture(value), code);
  });

  it.each([
    [
      'missing verdict',
      (value: JsonObject) => objectArrayAt(value.issues, 'issues').pop(),
      'missing-identity',
    ],
    [
      'duplicate verdict',
      (value: JsonObject) => {
        const verdicts = objectArrayAt(value.issues, 'issues');
        verdicts.push(clone(verdicts[0] ?? {}));
      },
      'duplicate-identity',
    ],
    [
      'unknown verdict',
      (value: JsonObject) => {
        objectEntryAt(value.issues, 0, 'issues').id = 'C9';
      },
      'unknown-identity',
    ],
    [
      'missing systemic disposition',
      (value: JsonObject) => objectArrayAt(value.systemic_dispositions, 'dispositions').pop(),
      'missing-identity',
    ],
    [
      'duplicate systemic disposition',
      (value: JsonObject) => {
        const dispositions = objectArrayAt(value.systemic_dispositions, 'dispositions');
        dispositions.push(clone(dispositions[0] ?? {}));
      },
      'duplicate-identity',
    ],
    [
      'unknown systemic disposition',
      (value: JsonObject) => {
        objectEntryAt(value.systemic_dispositions, 0, 'dispositions').issue_id = 'C9';
      },
      'unknown-identity',
    ],
    [
      'unapplied material issue',
      (value: JsonObject) => {
        value.applied = ['C1'];
      },
      'missing-identity',
    ],
    [
      'ungrounded local disposition',
      (value: JsonObject) => {
        objectEntryAt(value.systemic_dispositions, 0, 'dispositions').evidence_refs = [];
      },
      'ungrounded-evidence',
    ],
    [
      'ungrounded cross-cutting disposition',
      (value: JsonObject) => {
        objectEntryAt(value.systemic_dispositions, 1, 'dispositions').evidence_refs = [];
      },
      'ungrounded-evidence',
    ],
    [
      'duplicate cross-cutting occurrence tuple',
      (value: JsonObject) => {
        const second = objectArrayAt(value.systemic_dispositions, 'dispositions')[1];
        const invariant = objectAt(second?.invariant, 'invariant');
        const occurrences = objectArrayAt(invariant.occurrences, 'occurrences');
        occurrences.push(clone(occurrences[0] ?? {}));
      },
      'duplicate-identity',
    ],
  ] as const)('rejects %s', (_label, mutate, code) => {
    const value = clone(creatorFixture());
    mutate(value);
    expectCode(() => admitCreatorFixture(value), code);
  });

  it('accepts a validated operator supersession instead of local candidate evidence', () => {
    const value = clone(creatorFixture());
    const local = objectArrayAt(value.systemic_dispositions, 'dispositions')[0];
    if (local === undefined) {
      throw new Error('local disposition must exist');
    }
    local.evidence_refs = [];
    local.superseded_by = 'operator-1';

    const admitted = admitCreatorUpdate({
      value,
      currentCatalog: emptyCatalog(2),
      fromPlanVersion: 2,
      expectedPlanVersion: 3,
      expectedIssues: [
        {
          id: 'C1',
          severity: 'major',
          claim: 'The plan omits a required check.',
          evidence: 'The implementation checklist omits the check.',
          suggestedFix: 'Add the missing check.',
          provenance: 'critic',
        },
        {
          id: 'C2',
          severity: 'blocker',
          claim: 'Compatibility is not preserved.',
          evidence: 'The public projection changes incompatibly.',
          suggestedFix: 'Retain compatible output.',
          provenance: 'critic',
        },
      ],
      retainedFindings: [],
      retainedInvariants: [],
      evidenceContext: evidenceContext(3),
      operatorInterventionIds: ['operator-1'],
      admittedCriticIssueRefs: ['v2.C1', 'v2.C2'],
      admittedJudgeRevisionIssueIds: [],
    });

    expect(admitted.findings[0]?.disposition.supersededBy).toBe('operator-1');
  });
});

describe('fix-reviewer semantic admission', () => {
  it('derives summary facts and preserves violated and unresolved occurrence evidence', () => {
    const value = reviewerFixture({ O2: 'not-applicable', O3: 'violated', O4: 'unresolved' });
    value.approval = 'reject';
    value.concerns = [
      { id: 'R1', severity: 'major', claim: 'A major concern remains.', evidence: '## Evidence' },
    ];

    const admitted = admitFixReviewer({
      value,
      catalog: catalog(),
      binding: binding('fix-reviewer'),
      evidenceContext: evidenceContext(),
      requirementReason: 'retained-fix-replacement',
    });

    expect(admitted.materialIssueIds).toEqual(['fix-reviewer:R1']);
    expect(admitted.unresolvedOccurrenceIds).toEqual(['O4']);
    expect(admitted.violatedOccurrenceIds).toEqual(['O3']);
    expect(admitted.satisfied).toBe(false);
    expect(
      admitted.snapshot.occurrences.find((entry) => entry.occurrenceId === 'O2'),
    ).toMatchObject({
      disposition: 'not-applicable',
      evidenceGrounded: true,
    });
  });

  it('preserves a grounded violation without manufacturing a material concern', () => {
    const admitted = admitFixReviewer({
      value: reviewerFixture({ O3: 'violated' }),
      catalog: catalog(),
      binding: binding('fix-reviewer'),
      evidenceContext: evidenceContext(),
      requirementReason: 'retained-fix-replacement',
    });

    expect(admitted.approval).toBe('accept');
    expect(admitted.materialIssueIds).toEqual([]);
    expect(admitted.violatedOccurrenceIds).toEqual(['O3']);
    expect(admitted.satisfied).toBe(false);
  });

  it('accepts exact empty coverage only for a truly empty catalog', () => {
    const admitted = admitFixReviewer({
      value: {
        approval: 'accept',
        coverage_complete: true,
        unresolved_occurrence_ids: [],
        invariant_assessments: [],
        concerns: [],
      },
      catalog: emptyCatalog(),
      binding: binding('fix-reviewer'),
      evidenceContext: evidenceContext(),
      requirementReason: 'retained-fix-replacement',
    });

    expect(admitted.snapshot.occurrences).toEqual([]);
    expect(admitted.satisfied).toBe(true);
  });

  it.each([
    [
      'coverage_complete',
      (value: JsonObject) => {
        value.coverage_complete = false;
      },
    ],
    [
      'unresolved summary',
      (value: JsonObject) => {
        value.unresolved_occurrence_ids = [];
      },
    ],
    [
      'approval summary',
      (value: JsonObject) => {
        value.approval = 'accept_with_concerns';
      },
    ],
  ])('rejects contradictory %s', (_label, mutate) => {
    const value = reviewerFixture({ O4: 'unresolved' });
    mutate(value);
    expectCode(
      () =>
        admitFixReviewer({
          value,
          catalog: catalog(),
          binding: binding('fix-reviewer'),
          evidenceContext: evidenceContext(),
          requirementReason: 'retained-fix-replacement',
        }),
      'summary-mismatch',
    );
  });
});

describe('Judge semantic admission', () => {
  it('admits an intermediate negative verdict with one grounded revision issue', () => {
    const value = judgeFixture(false);
    value.revision_issue = {
      severity: 'major',
      category: 'correctness',
      claim: 'One current candidate defect remains.',
      evidence: '## Evidence',
      evidence_refs: GROUNDED_EVIDENCE,
      suggested_fix: 'Correct the candidate defect.',
    };

    const admitted = admitJudge({
      value,
      stage: 'intermediate',
      catalog: catalog(),
      binding: binding('intermediate-judge'),
      evidenceContext: evidenceContext(),
    });

    expect(admitted).toMatchObject({
      stage: 'intermediate',
      verdict: false,
      satisfied: true,
      revisionIssue: { severity: 'major', claim: 'One current candidate defect remains.' },
    });
    expect(admitted.materialIssueIds[0]).toMatch(/^judge-revision-[a-f0-9]{64}$/);
  });

  it('admits final negative occurrence proof without manufacturing a revision issue', () => {
    const admitted = admitJudge({
      value: judgeFixture(false, { O3: 'violated' }),
      stage: 'final',
      catalog: catalog(),
      binding: binding('final-judge'),
      evidenceContext: evidenceContext(),
    });

    expect(admitted.violatedOccurrenceIds).toEqual(['O3']);
    expect(admitted.materialIssueIds).toEqual([]);
    expect(admitted).not.toHaveProperty('revisionIssue');
  });

  it('rejects ready Judge proof with a violated occurrence', () => {
    expectCode(
      () =>
        admitJudge({
          value: judgeFixture(true, { O3: 'violated' }),
          stage: 'intermediate',
          catalog: catalog(),
          binding: binding('intermediate-judge'),
          evidenceContext: evidenceContext(),
        }),
      'summary-mismatch',
    );
  });

  it.each(['intermediate', 'final'] as const)(
    'rejects a revision issue inconsistent with a ready %s verdict',
    (stage) => {
      const value = judgeFixture(true);
      value.revision_issue = {
        severity: 'major',
        category: 'correctness',
        claim: 'Contradictory revision.',
        evidence: '## Evidence',
        evidence_refs: GROUNDED_EVIDENCE,
        suggested_fix: 'Revise despite ready.',
      };
      expectCode(
        () =>
          admitJudge({
            value,
            stage,
            catalog: catalog(),
            binding: binding(stage === 'intermediate' ? 'intermediate-judge' : 'final-judge'),
            evidenceContext: evidenceContext(),
          }),
        'summary-mismatch',
      );
    },
  );

  it('rejects any final Judge revision issue', () => {
    const value = judgeFixture(false);
    value.revision_issue = {
      severity: 'major',
      category: 'correctness',
      claim: 'Final Judge must not synthesize this issue.',
      evidence: '## Evidence',
      evidence_refs: GROUNDED_EVIDENCE,
      suggested_fix: 'Do not synthesize it.',
    };

    expectCode(
      () =>
        admitJudge({
          value,
          stage: 'final',
          catalog: catalog(),
          binding: binding('final-judge'),
          evidenceContext: evidenceContext(),
        }),
      'summary-mismatch',
    );
  });
});
