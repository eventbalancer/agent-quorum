import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addConvergenceLimit,
  applyReadinessPolicy,
  classifyTerminal,
  createConvergenceState,
  readConvergenceState,
  recordCritique,
  type ConvergenceState,
} from '../../src/core/convergence.js';
import { qualityMatrix } from '../../src/core/quality.js';
import { RISK_DOMAINS } from '../../src/core/readiness-contract.js';
import type { Quality } from '../../src/types.js';

const roots: string[] = [];
const REQUIRED_CONTEXT = [
  'original-scope',
  'authoritative-system-facts',
  'operator-decisions',
  'material-findings',
  'active-invariants',
  'quality-and-limits',
];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function state(quality: Quality = 'balanced', highRisk = false): ConvergenceState {
  const current = createConvergenceState({
    quality,
    matrix: qualityMatrix(quality),
    mode: 'prompt',
    sourceDigest: 'source',
    authoritativeDigest: 'system',
    relationshipIds: [],
    maxIters: 3,
  });
  applyReadinessPolicy(current, {
    contractDigest: 'contract',
    judgeAllowed: quality !== 'quick',
    exhaustiveApplicableDomains: quality === 'thorough',
    unresolvedMaterialQuestionIds: [],
    riskDomains: RISK_DOMAINS.map((domain) => ({
      domain,
      applicability: domain === 'correctness' ? 'applicable' : 'not-applicable',
      risk: highRisk && domain === 'correctness' ? 'high' : 'standard',
      rationale: `Fixture assessment for ${domain}.`,
      evidenceRefs: [],
    })),
  });
  return current;
}

function satisfyReview(current: ConvergenceState): void {
  current.lastCritiquedPlanVersion = current.planVersion;
  current.scanComplete = true;
  current.systemCheckPassed = true;
  for (const assessment of current.riskDomains) {
    if (assessment.applicability === 'applicable') {
      assessment.complete = true;
      assessment.lastAssessedPlanVersion = current.planVersion;
    }
  }
}

describe('bounded readiness decision reducer', () => {
  it('implements all four decisions and preserves reducer priority', () => {
    const ready = state();
    satisfyReview(ready);
    expect(classifyTerminal(ready).decision).toBe('ready');
    expect(ready.satisfied).toBe(true);

    const revision = state();
    satisfyReview(revision);
    revision.currentActionableIssues = ['v0.C1'];
    expect(classifyTerminal(revision).decision).toBe('revision-required');
    expect(revision.reasonCodes).toEqual(['material-issues']);

    const limited = state();
    limited.currentActionableIssues = ['v0.C1'];
    addConvergenceLimit(limited, 'iteration-cap', 'plan.v0:iteration-cap');
    expect(classifyTerminal(limited).decision).toBe('limits-exhausted');
    expect(limited.reasonCodes).toContain('iteration-cap');

    const unable = state();
    unable.currentActionableIssues = ['v0.C1'];
    addConvergenceLimit(unable, 'iteration-cap', 'plan.v0:iteration-cap');
    unable.boundaryChallenges.push({
      id: 'scope-fork',
      kind: 'scope-expansion',
      claim: 'The implementation needs a new repository.',
      rationale: 'The repository is outside the frozen boundary.',
      evidenceRefs: [],
      planVersion: 0,
    });
    expect(classifyTerminal(unable).decision).toBe('unable-to-decide');
    expect(unable.reasonCodes).toEqual(['boundary-challenge']);
  });

  it('rejects inconsistent scan proof when an applicable domain is incomplete', () => {
    const current = state();
    satisfyReview(current);
    const correctness = current.riskDomains.find(
      (assessment) => assessment.domain === 'correctness',
    );
    expect(correctness).toBeDefined();
    if (correctness !== undefined) {
      correctness.complete = false;
    }

    expect(current.scanComplete).toBe(true);
    expect(classifyTerminal(current)).toMatchObject({
      decision: 'unable-to-decide',
      satisfied: false,
      reasonCodes: ['applicable-domain-scan-incomplete'],
    });
    expect(current.unresolvedCoverage).toContain('plan.v0:scan-incomplete');
  });

  it('treats quality as appetite and requires Judge only for applicable high risk', () => {
    const quickHigh = state('quick', true);
    satisfyReview(quickHigh);
    expect(classifyTerminal(quickHigh).decision).toBe('limits-exhausted');
    expect(quickHigh.exhaustedLimits).toContain('assurance-appetite');

    const balancedStandard = state('balanced');
    satisfyReview(balancedStandard);
    expect(classifyTerminal(balancedStandard).decision).toBe('ready');

    const balancedHigh = state('balanced', true);
    satisfyReview(balancedHigh);
    expect(classifyTerminal(balancedHigh).reasonCodes).toContain('judge-unavailable');
    balancedHigh.judgeEvaluatedPlanVersion = 0;
    balancedHigh.judgeReady = true;
    balancedHigh.judgeApprovedPlanVersion = 0;
    expect(classifyTerminal(balancedHigh).decision).toBe('ready');

    const thorough = state('thorough');
    satisfyReview(thorough);
    thorough.scanComplete = false;
    expect(classifyTerminal(thorough).reasonCodes).toContain(
      'exhaustive-applicable-scan-incomplete',
    );
  });

  it('persists opportunities without making them material revision work', () => {
    const current = state();
    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'clean review with one opportunity',
        issues: [],
        domain_assessments: current.riskDomains.map((assessment) => ({
          domain: assessment.domain,
          applicability: assessment.applicability,
          risk: assessment.risk,
          complete: true,
          rationale: assessment.rationale,
          unavailable_evidence: [],
          evidence_refs: [],
        })),
        boundary_challenges: [],
        opportunities: [
          {
            fingerprint: 'O-docs',
            claim: 'The wording could be shorter.',
            evidence: 'Plan section is verbose.',
            suggested_improvement: 'Condense the paragraph.',
            evidence_refs: [],
          },
        ],
        review: {
          considered_context: REQUIRED_CONTEXT,
          scope_coverage: ['original-scope'],
          issue_budget: { limit: 8, used: 0, exhausted: false },
          scan_complete: true,
          invariant_assessments: [],
          unresolved_coverage: [],
        },
      },
      0,
    );
    expect(classifyTerminal(current).decision).toBe('ready');
    expect(current.currentActionableIssues).toEqual([]);
    expect(current.opportunities).toHaveLength(1);
  });

  it('conservatively reopens a previously inapplicable domain when review is uncertain', () => {
    const current = state();
    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'The performance applicability cannot be resolved from current evidence.',
        issues: [],
        domain_assessments: current.riskDomains.map((assessment) => ({
          domain: assessment.domain,
          applicability:
            assessment.domain === 'performance-cost' ? 'unknown' : assessment.applicability,
          risk: assessment.risk,
          complete: assessment.domain !== 'performance-cost',
          rationale: assessment.rationale,
          unavailable_evidence: [],
          evidence_refs: [],
        })),
        boundary_challenges: [],
        opportunities: [],
        review: {
          considered_context: REQUIRED_CONTEXT,
          scope_coverage: ['original-scope'],
          issue_budget: { limit: 8, used: 0, exhausted: false },
          scan_complete: true,
          invariant_assessments: [],
          unresolved_coverage: [],
        },
      },
      0,
    );

    expect(
      current.riskDomains.find((assessment) => assessment.domain === 'performance-cost')
        ?.applicability,
    ).toBe('unknown');
    expect(classifyTerminal(current)).toMatchObject({
      decision: 'unable-to-decide',
      reasonCodes: ['risk-applicability-unresolved'],
      satisfied: false,
    });
  });

  it('cannot become ready when critic scope or mandatory retained context was not reviewed', () => {
    const current = state();
    recordCritique(
      current,
      {
        plan_version: 0,
        summary: 'Incomplete review fixture.',
        issues: [],
        domain_assessments: current.riskDomains.map((assessment) => ({
          domain: assessment.domain,
          applicability: assessment.applicability,
          risk: assessment.risk,
          complete: true,
          rationale: assessment.rationale,
          unavailable_evidence: [],
          evidence_refs: [],
        })),
        boundary_challenges: [],
        opportunities: [],
        review: {
          considered_context: [],
          scope_coverage: [],
          issue_budget: { limit: 8, used: 0, exhausted: false },
          scan_complete: true,
          invariant_assessments: [],
          unresolved_coverage: [],
        },
      },
      0,
    );

    expect(current.scanComplete).toBe(false);
    expect(classifyTerminal(current)).toMatchObject({
      decision: 'unable-to-decide',
      satisfied: false,
    });
    expect(current.reasonCodes).toEqual(
      expect.arrayContaining([
        'applicable-domain-scan-incomplete',
        'critic-scope-coverage-incomplete',
        'critic-context-incomplete',
      ]),
    );
  });

  it.each([
    'v0.C1:creator-verdict',
    'I-v0-C1:not-applied',
    'I-v0-C1:systemic-disposition',
    'I-v0-C1:occurrence-matrix',
  ])('treats unresolved material creator lineage as a readiness gate (%s)', (marker) => {
    const current = state();
    satisfyReview(current);
    current.unresolvedCoverage = [marker];

    expect(classifyTerminal(current)).toMatchObject({
      decision: 'unable-to-decide',
      satisfied: false,
      reasonCodes: ['material-revision-proof-incomplete'],
    });
  });

  it('migrates schema v1 conservatively and requires a fresh review', () => {
    const legacy = createConvergenceState({
      quality: 'balanced',
      matrix: qualityMatrix('balanced'),
      mode: 'prompt',
      sourceDigest: 'source',
      authoritativeDigest: 'system',
      relationshipIds: [],
      maxIters: 3,
    });
    const serialized = JSON.parse(JSON.stringify(legacy)) as Record<string, unknown>;
    serialized.schemaVersion = 1;
    for (const key of [
      'requiredEvidenceUnavailable',
      'unresolvedMaterialQuestionIds',
      'judgeAllowed',
      'exhaustiveApplicableDomains',
      'riskDomains',
      'boundaryChallenges',
      'opportunities',
      'decision',
      'reasonCodes',
    ]) {
      Reflect.deleteProperty(serialized, key);
    }
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-readiness-v1.'));
    roots.push(root);
    const file = path.join(root, 'convergence.json');
    writeFileSync(file, `${JSON.stringify(serialized)}\n`);

    const migrated = readConvergenceState(file);
    expect(migrated).toBeDefined();
    expect(migrated?.schemaVersion).toBe(2);
    expect(migrated?.decision).toBe('unable-to-decide');
    expect(migrated?.reasonCodes).toContain('legacy-state-requires-review');
    expect(readFileSync(file, 'utf8')).toContain('"schemaVersion":1');
  });
});
