import { describe, expect, it } from 'vitest';
import { canonicalJsonSha256 } from '../../src/core/digest.js';
import type { JsonValue } from '../../src/core/json.js';
import { qualityMatrix } from '../../src/core/quality.js';
import {
  buildReadinessContract,
  type ReadinessContract,
} from '../../src/core/readiness-contract.js';
import {
  OCCURRENCE_SOURCES,
  READINESS_PROOF_SCHEMA_VERSION,
  READINESS_RISK_DOMAINS,
  RETAINED_CONTEXT_CATEGORIES,
  addBoundaryChallenge,
  addReadinessLimit,
  applyFrozenReadinessContract,
  bindCanonicalPlan,
  bindVersionedPlan,
  createOccurrenceSourceBinding,
  createReadinessProofCatalog,
  createReadinessProofState,
  invalidateDeterministicProof,
  invalidateFinalizationProof,
  invalidateFullReviewProof,
  invalidateOccurrenceCoverageSource,
  invalidateOccurrenceCoverageSources,
  markFinalArtifactReview,
  occurrenceSourceFacts,
  parseReadinessProofState,
  projectOccurrenceCoverage,
  recordAdmittedCreatorUpdate,
  recordAdmittedCritique,
  recordAdmittedFixReviewerProof,
  recordAdmittedJudgeProof,
  recordAuthoritativeContext,
  recordContextDelivery,
  recordInterventions,
  recordSystemProof,
  reduceReadinessProofState,
  replaceOccurrenceCoverageSnapshot,
  setOccurrenceSourceRequirement,
  type AdmittedOccurrenceDisposition,
  type CreateOccurrenceSourceRequirements,
  type NormalizedOccurrenceOutcome,
  type OccurrenceCoverageSnapshot,
  type OccurrenceEvaluationStage,
  type OccurrenceSource,
  type OccurrenceSourceBinding,
  type RawOccurrenceDisposition,
  type ReadinessInvariantRecord,
  type ReadinessProofCatalog,
  type ReadinessProofState,
  type ReadinessRiskDomainRecord,
  type RequiredOccurrenceSourceRequirement,
} from '../../src/core/readiness-proof.js';
import type { Quality, RiskDomain } from '../../src/types.js';

function catalog(
  overrides: Partial<{
    expectedPlanVersion: number;
    invariants: readonly { invariantId: string; occurrenceIds: readonly string[] }[];
    materialIssueIds: readonly string[];
  }> = {},
): ReadinessProofCatalog {
  return createReadinessProofCatalog({
    expectedPlanVersion: 2,
    invariants: [{ invariantId: 'I-1', occurrenceIds: ['O-1'] }],
    materialIssueIds: ['C1'],
    ...overrides,
  });
}

function binding(
  source: OccurrenceSource,
  overrides: Partial<{
    planVersion: number;
    contentDigest: string;
    evaluationStage: OccurrenceEvaluationStage;
    lineageDigest: string;
  }> = {},
): OccurrenceSourceBinding {
  const sourceIndex = OCCURRENCE_SOURCES.indexOf(source);
  return {
    candidate: {
      kind:
        source === 'fix-reviewer'
          ? 'fix-applied'
          : source === 'final-judge'
            ? 'canonical-plan'
            : 'versioned-plan',
      planVersion: overrides.planVersion ?? 2,
      contentDigest: overrides.contentDigest ?? String(sourceIndex + 1).repeat(64),
    },
    lineage: {
      evaluationStage:
        overrides.evaluationStage ??
        (source === 'critic'
          ? 'review'
          : source === 'fix-reviewer'
            ? 'fix-applied-review'
            : source === 'intermediate-judge'
              ? 'intermediate-readiness'
              : 'final-readiness'),
      lineageDigest: overrides.lineageDigest ?? String(sourceIndex + 5).repeat(64),
    },
  };
}

function required(source: OccurrenceSource): RequiredOccurrenceSourceRequirement {
  const reason =
    source === 'critic'
      ? 'independent-critic-required'
      : source === 'fix-reviewer'
        ? 'fix-pass-replacement-retained'
        : 'applicable-high-risk-judge-required';
  return {
    required: true,
    reason,
    expectedBinding: binding(source),
  };
}

function admittedDisposition(
  disposition: RawOccurrenceDisposition,
  occurrenceId = 'O-1',
  invariantId = 'I-1',
): AdmittedOccurrenceDisposition {
  return disposition === 'not-applicable'
    ? { invariantId, occurrenceId, disposition, evidenceGrounded: true }
    : { invariantId, occurrenceId, disposition, evidenceGrounded: true };
}

function snapshot(
  proofCatalog: ReadinessProofCatalog,
  source: OccurrenceSource,
  disposition: RawOccurrenceDisposition = 'satisfied',
  overrides: Partial<OccurrenceCoverageSnapshot> = {},
): OccurrenceCoverageSnapshot {
  return {
    source,
    catalogDigest: proofCatalog.digest,
    binding: binding(source),
    occurrences: [admittedDisposition(disposition)],
    ...overrides,
  };
}

function requiredState(
  source: OccurrenceSource = 'critic',
  proofCatalog = catalog(),
): ReadinessProofState {
  const requirements = {
    critic: required('critic'),
    ...(source === 'critic' ? {} : { [source]: required(source) }),
  } as CreateOccurrenceSourceRequirements;
  const state = createReadinessProofState(proofCatalog, requirements);
  return source === 'critic' ? state : attach(state, 'critic');
}

function attach(
  state: ReadinessProofState,
  source: OccurrenceSource,
  disposition: RawOccurrenceDisposition = 'satisfied',
  overrides: Partial<OccurrenceCoverageSnapshot> = {},
): ReadinessProofState {
  return replaceOccurrenceCoverageSnapshot(
    state,
    snapshot(state.catalog, source, disposition, overrides),
  );
}

function lifecycleState(quality: Quality = 'balanced'): ReadinessProofState {
  return createReadinessProofState({
    quality,
    matrix: qualityMatrix(quality),
    mode: 'prompt',
    sourceDigest: '0'.repeat(64),
    authoritativeDigest: 'f'.repeat(64),
    relationshipIds: ['R-1'],
    maxIters: 3,
  });
}

function frozenContract(
  state: ReadinessProofState,
  options: {
    readonly highRiskDomains?: readonly RiskDomain[];
    readonly materialQuestionIds?: readonly string[];
  } = {},
): ReadinessContract {
  const highRiskDomains = new Set(options.highRiskDomains ?? []);
  return buildReadinessContract({
    assessment: {
      boundary: {
        goal: 'Prove the retained plan is implementation-ready.',
        in_scope: ['current repository'],
        out_of_scope: [],
        constraints: ['preserve compatibility'],
      },
      domain_assessments: READINESS_RISK_DOMAINS.map((domain) => ({
        domain,
        applicability:
          domain === 'correctness' || highRiskDomains.has(domain) ? 'applicable' : 'not-applicable',
        risk: highRiskDomains.has(domain) ? 'high' : 'standard',
        rationale: `${domain} assessment`,
        evidence_refs: [],
      })),
      material_questions: (options.materialQuestionIds ?? []).map((id) => ({
        id,
        question: `Resolve ${id}?`,
        rationale: `${id} changes readiness`,
        options: ['yes', 'no'],
      })),
    },
    sourceDigest: state.sourceDigest,
    systemDigest: state.authoritativeDigest,
    quality: state.quality,
    iterationLimit: state.iterationLimit,
    issueBudget: state.issueBudget.limit,
    operatorDecisionIds: ['D-1'],
  });
}

function assessedRiskDomains(
  contract: ReadinessContract,
  planVersion: number,
): ReadinessRiskDomainRecord[] {
  return contract.domainAssessments.map((assessment) => ({
    ...assessment,
    complete: true,
    unavailableEvidence: [],
    lastAssessedPlanVersion: planVersion,
  }));
}

function snapshotForState(
  state: ReadinessProofState,
  source: OccurrenceSource,
  disposition: RawOccurrenceDisposition = 'satisfied',
): OccurrenceCoverageSnapshot {
  const slot = state.sources.find((entry) => entry.source === source);
  if (slot?.requirement.required !== true) {
    throw new TypeError(`${source} must be required in the fixture`);
  }
  return {
    source,
    catalogDigest: state.catalog.digest,
    binding: slot.requirement.expectedBinding,
    occurrences: state.catalog.invariants.flatMap((invariant) =>
      invariant.occurrenceIds.map((occurrenceId) => ({
        invariantId: invariant.invariantId,
        occurrenceId,
        disposition,
        evidenceGrounded: true,
      })),
    ),
  };
}

function bindCurrentVersion(state: ReadinessProofState): ReadinessProofState {
  return bindVersionedPlan(state, {
    planVersion: state.planVersion,
    planSha256: 'a'.repeat(64),
    criticLineageDigest: 'b'.repeat(64),
    ...(state.sources.find((source) => source.source === 'intermediate-judge')?.requirement.required
      ? { intermediateJudgeLineageDigest: 'c'.repeat(64) }
      : {}),
  });
}

function recordCleanCritique(
  state: ReadinessProofState,
  contract: ReadinessContract,
  overrides: Partial<{
    criticCoverageGapIds: readonly string[];
    criticScopeCoverageGapIds: readonly string[];
    criticContextGapIds: readonly string[];
    opportunities: ReadinessProofState['opportunities'];
    materialIssueIds: readonly string[];
  }> = {},
): ReadinessProofState {
  const materialIssueIds = overrides.materialIssueIds ?? [];
  return recordAdmittedCritique(state, {
    planVersion: state.planVersion,
    snapshot: snapshotForState(state, 'critic'),
    scanComplete: true,
    declaredScopeVerified: true,
    materialIssueIds,
    issueBudgetUsed: materialIssueIds.length,
    issueBudgetExhausted: false,
    riskDomains: assessedRiskDomains(contract, state.planVersion),
    criticCoverageGapIds: overrides.criticCoverageGapIds ?? [],
    criticScopeCoverageGapIds: overrides.criticScopeCoverageGapIds ?? [],
    criticContextGapIds: overrides.criticContextGapIds ?? [],
    boundaryChallenges: [],
    opportunities: overrides.opportunities ?? [],
  });
}

describe('readiness proof catalog', () => {
  it('freezes the fixed domains and retained-context categories into a deterministic digest', () => {
    const left = catalog({
      invariants: [
        { invariantId: 'I-2', occurrenceIds: ['O-3'] },
        { invariantId: 'I-1', occurrenceIds: ['O-2', 'O-1'] },
      ],
      materialIssueIds: ['C2', 'C1'],
    });
    const right = catalog({
      invariants: [
        { invariantId: 'I-1', occurrenceIds: ['O-1', 'O-2'] },
        { invariantId: 'I-2', occurrenceIds: ['O-3'] },
      ],
      materialIssueIds: ['C1', 'C2'],
    });

    expect(left).toEqual(right);
    expect(left.riskDomainIds).toEqual(READINESS_RISK_DOMAINS);
    expect(left.retainedContextCategories).toEqual(RETAINED_CONTEXT_CATEGORIES);
    expect(left.digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects duplicate invariant, occurrence, and material issue identities', () => {
    expect(() =>
      catalog({
        invariants: [
          { invariantId: 'I-1', occurrenceIds: ['O-1'] },
          { invariantId: 'I-1', occurrenceIds: ['O-2'] },
        ],
      }),
    ).toThrow('catalog invariant IDs must not contain duplicates');
    expect(() =>
      catalog({
        invariants: [
          { invariantId: 'I-1', occurrenceIds: ['O-1'] },
          { invariantId: 'I-2', occurrenceIds: ['O-1'] },
        ],
      }),
    ).toThrow('catalog occurrence belongs to multiple invariants');
    expect(() => catalog({ materialIssueIds: ['C1', 'C1'] })).toThrow(
      'catalog material issue IDs must not contain duplicates',
    );
  });
});

describe('occurrence disposition reconciliation', () => {
  it.each<{
    disposition: RawOccurrenceDisposition;
    outcome: NormalizedOccurrenceOutcome;
    satisfied: boolean;
  }>([
    { disposition: 'satisfied', outcome: 'resolved', satisfied: true },
    { disposition: 'not-applicable', outcome: 'resolved', satisfied: true },
    { disposition: 'violated', outcome: 'violated', satisfied: false },
    { disposition: 'unresolved', outcome: 'unresolved', satisfied: false },
  ])('normalizes $disposition to $outcome', ({ disposition, outcome, satisfied }) => {
    const state = attach(requiredState(), 'critic', disposition);
    const projection = projectOccurrenceCoverage(state);

    expect(projection.outcomes).toEqual([{ invariantId: 'I-1', occurrenceId: 'O-1', outcome }]);
    expect(projection.proofSatisfied).toBe(satisfied);
  });

  it.each(['satisfied', 'violated', 'not-applicable'] as const)(
    'rejects an ungrounded %s value before it can enter a snapshot',
    (disposition) => {
      const state = requiredState();
      const ungrounded = {
        source: 'critic',
        catalogDigest: state.catalog.digest,
        binding: binding('critic'),
        occurrences: [
          {
            invariantId: 'I-1',
            occurrenceId: 'O-1',
            disposition,
            evidenceGrounded: false,
          },
        ],
      } as unknown as OccurrenceCoverageSnapshot;

      expect(() => replaceOccurrenceCoverageSnapshot(state, ungrounded)).toThrow(
        `${disposition} occurrence evidence must be grounded`,
      );
      expect(state.sources.find((slot) => slot.source === 'critic')?.snapshot).toBeUndefined();
    },
  );

  it.each(OCCURRENCE_SOURCES)('supports the %s source slot', (source) => {
    const state = attach(requiredState(source), source);
    const projection = projectOccurrenceCoverage(state);

    expect(projection.proofSatisfied).toBe(true);
    expect(projection.sources.find((entry) => entry.source === source)).toMatchObject({
      required: true,
      catalogExact: true,
      current: true,
      consistent: true,
      conclusive: true,
    });
  });

  it('records resolved-versus-violated disagreement without preferring a role', () => {
    const proofCatalog = catalog();
    let state = createReadinessProofState(proofCatalog, {
      critic: required('critic'),
      'final-judge': required('final-judge'),
    });
    state = attach(state, 'critic', 'not-applicable');
    state = attach(state, 'final-judge', 'violated');

    expect(projectOccurrenceCoverage(state)).toMatchObject({
      resolvedOccurrenceIds: [],
      violatedOccurrenceIds: ['O-1'],
      unresolvedOccurrenceIds: [],
      disagreementOccurrenceIds: ['O-1'],
      sourceConsistent: false,
      proofSatisfied: false,
    });
    expect(occurrenceSourceFacts(state).filter((source) => source.required)).toEqual([
      expect.objectContaining({ source: 'critic', consistent: false }),
      expect.objectContaining({ source: 'final-judge', consistent: false }),
    ]);
  });

  it('preserves a current violation when another required source is inconclusive', () => {
    const proofCatalog = catalog();
    let state = createReadinessProofState(proofCatalog, {
      critic: required('critic'),
      'intermediate-judge': required('intermediate-judge'),
    });
    state = attach(state, 'critic', 'violated');
    state = attach(state, 'intermediate-judge', 'unresolved');

    expect(projectOccurrenceCoverage(state)).toMatchObject({
      violatedOccurrenceIds: ['O-1'],
      unresolvedOccurrenceIds: [],
      proofSatisfied: false,
    });
  });
});

describe('source requirements and currency', () => {
  it('derives stable source-compatible lineage from trusted proof and candidate identity', () => {
    const state = lifecycleState();
    const critic = createOccurrenceSourceBinding(state, {
      source: 'critic',
      candidateKind: 'versioned-plan',
      contentDigest: 'a'.repeat(64),
    });
    expect(critic).toEqual(
      createOccurrenceSourceBinding(state, {
        source: 'critic',
        candidateKind: 'versioned-plan',
        contentDigest: 'a'.repeat(64),
      }),
    );
    expect(critic.lineage.evaluationStage).toBe('review');
    expect(
      createOccurrenceSourceBinding(state, {
        source: 'critic',
        candidateKind: 'versioned-plan',
        contentDigest: 'b'.repeat(64),
      }).lineage.lineageDigest,
    ).not.toBe(critic.lineage.lineageDigest);
    expect(() =>
      createOccurrenceSourceBinding(state, {
        source: 'critic',
        candidateKind: 'canonical-plan',
        contentDigest: 'a'.repeat(64),
      }),
    ).toThrow('candidate kind is invalid for source');
  });

  it('requires the critic and source-compatible candidate lineage', () => {
    const state = requiredState();

    expect(() =>
      setOccurrenceSourceRequirement(state, 'critic', {
        required: false,
        reason: 'invalid-exemption',
      }),
    ).toThrow('critic occurrence source must be required');
    expect(() =>
      setOccurrenceSourceRequirement(state, 'critic', {
        required: true,
        reason: 'independent-critic-required',
        expectedBinding: binding('final-judge'),
      }),
    ).toThrow('candidate binding is invalid for source: critic');
  });

  it('keeps a required missing source unresolved and allows an explicit exemption', () => {
    let state = requiredState('fix-reviewer');
    expect(projectOccurrenceCoverage(state)).toMatchObject({
      unresolvedOccurrenceIds: ['O-1'],
      catalogExact: false,
      sourcesCurrent: false,
      sourcesConclusive: false,
      proofSatisfied: false,
    });

    state = setOccurrenceSourceRequirement(state, 'fix-reviewer', {
      required: false,
      reason: 'pre-fix-restored',
    });
    expect(projectOccurrenceCoverage(state)).toMatchObject({
      resolvedOccurrenceIds: ['O-1'],
      unresolvedOccurrenceIds: [],
      proofSatisfied: true,
    });
  });

  it('invalidates a previously current snapshot when its expected binding changes', () => {
    const current = attach(requiredState(), 'critic');
    const stale = setOccurrenceSourceRequirement(current, 'critic', {
      required: true,
      reason: 'independent-critic-required',
      expectedBinding: binding('critic', { contentDigest: '9'.repeat(64) }),
    });

    expect(stale.sources.find((source) => source.source === 'critic')?.snapshot).toBeUndefined();
    expect(projectOccurrenceCoverage(stale)).toMatchObject({
      unresolvedOccurrenceIds: ['O-1'],
      sourcesCurrent: false,
      proofSatisfied: false,
    });
  });

  it.each([
    {
      name: 'stale catalog',
      snapshotOverrides: { catalogDigest: 'e'.repeat(64) },
      message: 'snapshot catalog digest is stale',
    },
    {
      name: 'stale binding',
      snapshotOverrides: { binding: binding('critic', { contentDigest: '9'.repeat(64) }) },
      message: 'snapshot binding is stale',
    },
    {
      name: 'inexact occurrence coverage',
      snapshotOverrides: { occurrences: [] },
      message: 'snapshot occurrence coverage is not catalog-exact',
    },
  ])('rejects a $name snapshot atomically', ({ snapshotOverrides, message }) => {
    const state = requiredState();
    expect(() => attach(state, 'critic', 'satisfied', snapshotOverrides)).toThrow(message);
    expect(projectOccurrenceCoverage(state)).toMatchObject({
      unresolvedOccurrenceIds: ['O-1'],
      proofSatisfied: false,
    });
  });

  it('retains an exact inconclusive snapshot as unresolved proof', () => {
    const state = attach(requiredState(), 'critic', 'unresolved');
    expect(projectOccurrenceCoverage(state)).toMatchObject({
      unresolvedOccurrenceIds: ['O-1'],
      catalogExact: true,
      sourcesCurrent: true,
      sourcesConclusive: false,
      proofSatisfied: false,
    });
  });

  it('clears an attached snapshot when its source becomes exempt', () => {
    const attached = attach(requiredState('fix-reviewer'), 'fix-reviewer');
    const exempt = setOccurrenceSourceRequirement(attached, 'fix-reviewer', {
      required: false,
      reason: 'replacement-rejected',
    });

    expect(exempt.sources.find((slot) => slot.source === 'fix-reviewer')?.snapshot).toBeUndefined();
    expect(projectOccurrenceCoverage(exempt).proofSatisfied).toBe(true);
  });
});

describe('atomic source transitions', () => {
  it('replaces an unresolved snapshot from scratch without retaining a stale aggregate ID', () => {
    const unresolved = attach(requiredState(), 'critic', 'unresolved');
    expect(unresolved.occurrenceCoverage.unresolvedOccurrenceIds).toEqual(['O-1']);

    const resolved = attach(unresolved, 'critic', 'satisfied');
    expect(resolved.occurrenceCoverage).toMatchObject({
      resolvedOccurrenceIds: ['O-1'],
      violatedOccurrenceIds: [],
      unresolvedOccurrenceIds: [],
      disagreementOccurrenceIds: [],
      proofSatisfied: true,
    });
  });

  it('invalidates one or several complete source snapshots atomically', () => {
    const proofCatalog = catalog();
    let state = createReadinessProofState(proofCatalog, {
      critic: required('critic'),
      'intermediate-judge': required('intermediate-judge'),
    });
    state = attach(state, 'critic');
    state = attach(state, 'intermediate-judge');
    expect(state.occurrenceCoverage.proofSatisfied).toBe(true);

    const oneInvalid = invalidateOccurrenceCoverageSource(state, 'critic');
    expect(oneInvalid.occurrenceCoverage.proofSatisfied).toBe(false);
    expect(oneInvalid.sources.find((slot) => slot.source === 'critic')?.snapshot).toBeUndefined();
    expect(
      oneInvalid.sources.find((slot) => slot.source === 'intermediate-judge')?.snapshot,
    ).toBeDefined();

    const allInvalid = invalidateOccurrenceCoverageSources(state, ['critic', 'intermediate-judge']);
    expect(allInvalid.sources.filter((slot) => slot.snapshot !== undefined)).toEqual([]);
  });

  it('does not mutate the prior state or caller-owned snapshot', () => {
    const initial = requiredState();
    const input = snapshot(initial.catalog, 'critic', 'satisfied', {
      occurrences: [admittedDisposition('satisfied')],
    });
    const initialBefore = structuredClone(initial);
    const inputBefore = structuredClone(input);

    const next = replaceOccurrenceCoverageSnapshot(initial, input);
    expect(initial).toEqual(initialBefore);
    expect(input).toEqual(inputBefore);
    expect(next).not.toBe(initial);
    expect(next.sources).not.toBe(initial.sources);
    expect(next.occurrenceCoverage.proofSatisfied).toBe(true);
  });
});

describe('strict readiness proof parsing', () => {
  it('round-trips current schema state and rejects older versions', () => {
    const state = attach(requiredState(), 'critic');
    const serialized = JSON.parse(JSON.stringify(state)) as JsonValue;

    expect(parseReadinessProofState(serialized)).toEqual(state);
    const old = structuredClone(serialized) as { schemaVersion: number };
    old.schemaVersion = READINESS_PROOF_SCHEMA_VERSION - 1;
    expect(() => parseReadinessProofState(old as JsonValue)).toThrow('schemaVersion must be 3');
  });

  it('accepts canonical unbound expected bindings only while their source has no snapshot', () => {
    const state = lifecycleState();
    const critic = state.sources.find((source) => source.source === 'critic');

    if (critic?.requirement.required !== true) {
      throw new TypeError('critic requirement fixture is unavailable');
    }
    expect(critic.requirement.expectedBinding.candidate.contentDigest).toMatch(
      /^unbound:[0-9a-f]{64}$/,
    );
    expect(critic.requirement.expectedBinding.lineage.lineageDigest).toMatch(
      /^unbound:[0-9a-f]{64}$/,
    );
    expect(critic.snapshot).toBeUndefined();
    expect(parseReadinessProofState(JSON.parse(JSON.stringify(state)) as JsonValue)).toEqual(state);
  });

  it.each(OCCURRENCE_SOURCES)('rejects an arbitrary persisted required reason for %s', (source) => {
    const serialized = JSON.parse(JSON.stringify(requiredState(source))) as {
      sources: { source: OccurrenceSource; requirement: { reason: string } }[];
    };
    const slot = serialized.sources.find((candidate) => candidate.source === source);
    if (slot === undefined) {
      throw new TypeError(`${source} source fixture is unavailable`);
    }
    slot.requirement.reason = 'provider-supplied-reason';

    expect(() => parseReadinessProofState(serialized as unknown as JsonValue)).toThrow(
      `source requirement reason is invalid for ${source}`,
    );
  });

  it.each(['fix-reviewer', 'intermediate-judge', 'final-judge'] as const)(
    'rejects an arbitrary persisted exemption reason for %s',
    (source) => {
      const serialized = JSON.parse(JSON.stringify(lifecycleState())) as {
        sources: { source: OccurrenceSource; requirement: { reason: string } }[];
      };
      const slot = serialized.sources.find((candidate) => candidate.source === source);
      if (slot === undefined) {
        throw new TypeError(`${source} source fixture is unavailable`);
      }
      slot.requirement.reason = 'provider-supplied-exemption';

      expect(() => parseReadinessProofState(serialized as unknown as JsonValue)).toThrow(
        `source requirement reason is invalid for ${source}`,
      );
    },
  );

  it.each([
    {
      label: 'planSha256',
      mutate: (value: Record<string, unknown>): void => {
        value.planSha256 = 'not-a-digest';
      },
    },
    {
      label: 'canonicalPlanSha256',
      mutate: (value: Record<string, unknown>): void => {
        value.canonicalPlanSha256 = 'not-a-digest';
      },
    },
    {
      label: 'systemProofBinding.planSha256',
      mutate: (value: Record<string, unknown>): void => {
        const binding = value.systemProofBinding as Record<string, unknown>;
        binding.planSha256 = 'not-a-digest';
      },
    },
    {
      label: 'sourceDigest',
      mutate: (value: Record<string, unknown>): void => {
        value.sourceDigest = 'A'.repeat(64);
      },
    },
    {
      label: 'authoritativeDigest',
      mutate: (value: Record<string, unknown>): void => {
        value.authoritativeDigest = 'f'.repeat(63);
      },
    },
    {
      label: 'readinessContractDigest',
      mutate: (value: Record<string, unknown>): void => {
        value.readinessContractDigest = 'not-a-digest';
      },
    },
    {
      label: 'systemProofBinding.authoritativeDigest',
      mutate: (value: Record<string, unknown>): void => {
        const binding = value.systemProofBinding as Record<string, unknown>;
        binding.authoritativeDigest = 'A'.repeat(64);
      },
    },
    {
      label: 'catalog.digest',
      mutate: (value: Record<string, unknown>): void => {
        const storedCatalog = value.catalog as Record<string, unknown>;
        storedCatalog.digest = 'A'.repeat(64);
      },
    },
  ])('rejects malformed persisted $label', ({ label, mutate }) => {
    const initial = lifecycleState();
    let state = bindCurrentVersion(applyFrozenReadinessContract(initial, frozenContract(initial)));
    state = bindCanonicalPlan(state, {
      planVersion: state.planVersion,
      canonicalPlanSha256: 'd'.repeat(64),
      compatibleWithVersionedProof: true,
    });
    state = recordSystemProof(state, {
      binding: {
        planVersion: state.planVersion,
        planSha256: 'd'.repeat(64),
        authoritativeDigest: state.authoritativeDigest,
      },
      passed: false,
      mismatchIds: ['system-mismatch'],
      unavailableEvidenceIds: [],
    });
    const serialized = JSON.parse(JSON.stringify(state)) as Record<string, unknown>;
    mutate(serialized);

    expect(() => parseReadinessProofState(serialized as JsonValue)).toThrow(
      `${label} must be a lowercase 64-character SHA-256 digest`,
    );
  });

  it.each([
    {
      label: 'expected candidate digest',
      mutate: (source: Record<string, unknown>): void => {
        const requirement = source.requirement as Record<string, unknown>;
        const expected = requirement.expectedBinding as Record<string, unknown>;
        const candidate = expected.candidate as Record<string, unknown>;
        candidate.contentDigest = 'not-a-digest';
      },
    },
    {
      label: 'expected lineage digest',
      mutate: (source: Record<string, unknown>): void => {
        const requirement = source.requirement as Record<string, unknown>;
        const expected = requirement.expectedBinding as Record<string, unknown>;
        const lineage = expected.lineage as Record<string, unknown>;
        lineage.lineageDigest = 'not-a-digest';
      },
    },
    {
      label: 'snapshot catalog digest',
      mutate: (source: Record<string, unknown>): void => {
        const snapshotValue = source.snapshot as Record<string, unknown>;
        snapshotValue.catalogDigest = 'A'.repeat(64);
      },
    },
    {
      label: 'snapshot unbound digest',
      mutate: (source: Record<string, unknown>): void => {
        const snapshotValue = source.snapshot as Record<string, unknown>;
        const snapshotBinding = snapshotValue.binding as Record<string, unknown>;
        const candidate = snapshotBinding.candidate as Record<string, unknown>;
        const lineage = snapshotBinding.lineage as Record<string, unknown>;
        candidate.contentDigest = `unbound:${'a'.repeat(64)}`;
        lineage.lineageDigest = `unbound:${'b'.repeat(64)}`;
      },
    },
  ])('rejects a malformed persisted occurrence $label', ({ label, mutate }) => {
    const serialized = JSON.parse(JSON.stringify(attach(requiredState(), 'critic'))) as {
      sources: Record<string, unknown>[];
    };
    const critic = serialized.sources[0];
    if (critic === undefined) {
      throw new TypeError('critic source fixture is unavailable');
    }
    mutate(critic);

    expect(() => parseReadinessProofState(serialized as unknown as JsonValue)).toThrow(
      label === 'snapshot unbound digest'
        ? 'snapshot.binding.candidate.contentDigest must be a lowercase 64-character SHA-256 digest'
        : label === 'snapshot catalog digest'
          ? 'snapshot.catalogDigest must be a lowercase 64-character SHA-256 digest'
          : 'must be a lowercase 64-character SHA-256 digest',
    );
  });

  it('rejects a partially unbound expected binding even when its source has no snapshot', () => {
    const serialized = JSON.parse(JSON.stringify(lifecycleState())) as {
      sources: {
        requirement: {
          expectedBinding?: { candidate: { contentDigest: string } };
        };
      }[];
    };
    const expectedBinding = serialized.sources[0]?.requirement.expectedBinding;
    if (expectedBinding === undefined) {
      throw new TypeError('critic expected binding fixture is unavailable');
    }
    expectedBinding.candidate.contentDigest = 'a'.repeat(64);

    expect(() => parseReadinessProofState(serialized as unknown as JsonValue)).toThrow(
      'must not mix bound and unbound digests',
    );
  });

  it('rejects malformed unbound digest payloads on a required source without a snapshot', () => {
    const serialized = JSON.parse(JSON.stringify(lifecycleState())) as {
      sources: {
        requirement: {
          expectedBinding?: {
            candidate: { contentDigest: string };
            lineage: { lineageDigest: string };
          };
        };
      }[];
    };
    const expectedBinding = serialized.sources[0]?.requirement.expectedBinding;
    if (expectedBinding === undefined) {
      throw new TypeError('critic expected binding fixture is unavailable');
    }
    expectedBinding.candidate.contentDigest = 'unbound:not-a-digest';
    expectedBinding.lineage.lineageDigest = 'unbound:not-a-digest';

    expect(() => parseReadinessProofState(serialized as unknown as JsonValue)).toThrow(
      'must be a lowercase 64-character SHA-256 digest or unbound SHA-256 digest',
    );
  });

  it('round-trips source-owned material issues after restoring admitted snapshots', () => {
    const initial = lifecycleState();
    const contract = frozenContract(initial);
    const bound = bindCurrentVersion(applyFrozenReadinessContract(initial, contract));
    const reviewed = recordAdmittedCritique(bound, {
      planVersion: 0,
      snapshot: snapshotForState(bound, 'critic'),
      scanComplete: true,
      declaredScopeVerified: true,
      materialIssueIds: ['v0.C1'],
      issueBudgetUsed: 1,
      issueBudgetExhausted: false,
      riskDomains: assessedRiskDomains(contract, 0),
      criticCoverageGapIds: [],
      criticScopeCoverageGapIds: [],
      criticContextGapIds: [],
      boundaryChallenges: [],
      opportunities: [],
    });

    expect(reviewed.admittedCriticIssueRefs).toEqual(['v0.C1']);
    expect(parseReadinessProofState(JSON.parse(JSON.stringify(reviewed)) as JsonValue)).toEqual(
      reviewed,
    );
    expect(invalidateOccurrenceCoverageSource(reviewed, 'critic').admittedCriticIssueRefs).toEqual(
      [],
    );
  });

  it('rejects forged or future admitted critic issue history', () => {
    const malformed = JSON.parse(JSON.stringify(lifecycleState())) as {
      admittedCriticIssueRefs: string[];
    };
    malformed.admittedCriticIssueRefs = ['v1.C9'];

    expect(() => parseReadinessProofState(malformed as JsonValue)).toThrow(
      'admitted critic issue refs must identify current or prior plan versions',
    );
  });

  it('rejects a stored ledger that differs from canonical recomputation', () => {
    const serialized = JSON.parse(JSON.stringify(attach(requiredState(), 'critic'))) as {
      occurrenceCoverage: { proofSatisfied: boolean };
    };
    serialized.occurrenceCoverage.proofSatisfied = false;

    expect(() => parseReadinessProofState(serialized as JsonValue)).toThrow(
      'stored readiness proof state does not match canonical recomputation',
    );
  });

  it('rejects invalid numeric state and catalog-to-invariant identity drift', () => {
    const numeric = JSON.parse(JSON.stringify(attach(requiredState(), 'critic'))) as {
      issueBudget: { limit: number };
    };
    numeric.issueBudget.limit = -1;
    expect(() => parseReadinessProofState(numeric as JsonValue)).toThrow(
      'issueBudget.limit must be a non-negative integer',
    );

    const identity = JSON.parse(JSON.stringify(attach(requiredState(), 'critic'))) as {
      invariants: { occurrences: { id: string }[] }[];
    };
    const firstOccurrence = identity.invariants[0]?.occurrences[0];
    if (firstOccurrence === undefined) {
      throw new TypeError('identity fixture must contain one occurrence');
    }
    firstOccurrence.id = 'O-tampered';
    expect(() => parseReadinessProofState(identity as JsonValue)).toThrow(
      'invariant metadata does not match readiness proof catalog',
    );
  });
});

describe('immutable readiness proof lifecycle', () => {
  it('rejects malformed digest inputs across direct proof transitions', () => {
    expect(() =>
      createReadinessProofState({
        quality: 'balanced',
        matrix: qualityMatrix('balanced'),
        mode: 'prompt',
        sourceDigest: 'A'.repeat(64),
        authoritativeDigest: 'f'.repeat(64),
        relationshipIds: [],
        maxIters: 3,
      }),
    ).toThrow('sourceDigest must be a lowercase 64-character SHA-256 digest');

    const initial = lifecycleState();
    expect(() =>
      createOccurrenceSourceBinding(initial, {
        source: 'critic',
        candidateKind: 'versioned-plan',
        contentDigest: 'not-a-digest',
      }),
    ).toThrow('candidate contentDigest must be a lowercase 64-character SHA-256 digest');
    expect(() =>
      bindVersionedPlan(initial, {
        planVersion: initial.planVersion,
        planSha256: 'a'.repeat(64),
        criticLineageDigest: 'B'.repeat(64),
      }),
    ).toThrow('critic lineage digest must be a lowercase 64-character SHA-256 digest');
    expect(() =>
      bindVersionedPlan(initial, {
        planVersion: initial.planVersion,
        planSha256: 'a'.repeat(64),
        criticLineageDigest: 'b'.repeat(64),
        intermediateJudgeLineageDigest: 'not-a-digest',
      }),
    ).toThrow('intermediate Judge lineage digest must be a lowercase 64-character SHA-256 digest');
    expect(() =>
      bindCanonicalPlan(initial, {
        planVersion: initial.planVersion,
        canonicalPlanSha256: 'canonical-plan',
        compatibleWithVersionedProof: true,
      }),
    ).toThrow('canonical plan SHA-256 must be a lowercase 64-character SHA-256 digest');
    expect(() =>
      bindCanonicalPlan(initial, {
        planVersion: initial.planVersion,
        canonicalPlanSha256: 'd'.repeat(64),
        finalJudgeLineageDigest: 'not-a-digest',
        compatibleWithVersionedProof: true,
      }),
    ).toThrow('final Judge lineage digest must be a lowercase 64-character SHA-256 digest');
    expect(() =>
      recordAuthoritativeContext(initial, {
        authoritativeDigest: 'changed-system',
        relationshipIds: [],
      }),
    ).toThrow('authoritative digest must be a lowercase 64-character SHA-256 digest');

    const bound = bindCurrentVersion(initial);
    expect(() =>
      recordSystemProof(bound, {
        binding: {
          planVersion: bound.planVersion,
          planSha256: bound.planSha256 ?? '',
          authoritativeDigest: 'A'.repeat(64),
        },
        passed: false,
        mismatchIds: [],
        unavailableEvidenceIds: [],
      }),
    ).toThrow('system proof authoritativeDigest must be a lowercase 64-character SHA-256 digest');
    expect(() =>
      markFinalArtifactReview(bound, {
        planVersion: bound.planVersion,
        canonicalPlanSha256: 'not-a-digest',
        fresh: true,
        judgeConsistent: true,
      }),
    ).toThrow('canonical plan SHA-256 must be a lowercase 64-character SHA-256 digest');

    const forgedCatalog = { ...catalog(), digest: 'A'.repeat(64) };
    expect(() => createReadinessProofState(forgedCatalog, { critic: required('critic') })).toThrow(
      'catalog digest must be a lowercase 64-character SHA-256 digest',
    );
    expect(() =>
      attach(requiredState(), 'critic', 'satisfied', { catalogDigest: 'bad-catalog' }),
    ).toThrow('snapshot catalogDigest must be a lowercase 64-character SHA-256 digest');

    const forgedContract = structuredClone(frozenContract(initial)) as unknown as {
      sourceDigest: string;
    };
    forgedContract.sourceDigest = 'A'.repeat(64);
    expect(() =>
      applyFrozenReadinessContract(initial, forgedContract as unknown as ReadinessContract),
    ).toThrow('sourceDigest must be a lowercase 64-character SHA-256 digest');
  });

  it('applies the frozen contract and stores only a recomputed reduction', () => {
    const initial = lifecycleState();
    const before = structuredClone(initial);
    const contract = frozenContract(initial, { materialQuestionIds: ['Q1'] });

    const applied = applyFrozenReadinessContract(initial, contract);

    expect(initial).toEqual(before);
    expect(applied).not.toBe(initial);
    expect(applied).toMatchObject({
      readinessContractDigest: contract.contractDigest,
      operatorDecisionIds: ['D-1'],
      unresolvedMaterialQuestionIds: ['Q1'],
      judgeAllowed: true,
      exhaustiveApplicableDomains: false,
      reduction: {
        decision: 'unable-to-decide',
        reasonCodes: ['material-question-unresolved'],
      },
    });
    expect(applied.riskDomains).toHaveLength(READINESS_RISK_DOMAINS.length);
    expect(reduceReadinessProofState(applied)).toEqual(applied);
    expect('unresolvedCoverage' in applied).toBe(false);

    const directPlan = createReadinessProofState({
      quality: 'balanced',
      matrix: qualityMatrix('balanced'),
      mode: 'plan',
      sourceDigest: '0'.repeat(64),
      authoritativeDigest: 'f'.repeat(64),
      relationshipIds: [],
      maxIters: 3,
    });
    expect(
      applyFrozenReadinessContract(directPlan, frozenContract(directPlan)).declaredScopeVerified,
    ).toBe(false);
  });

  it('reaches readiness through admitted critique without allowing opportunities to affect proof', () => {
    const initial = lifecycleState();
    const contract = frozenContract(initial);
    const bound = bindCurrentVersion(applyFrozenReadinessContract(initial, contract));
    const before = structuredClone(bound);
    const withoutOpportunity = recordCleanCritique(bound, contract);
    const withOpportunity = recordCleanCritique(bound, contract, {
      opportunities: [
        {
          fingerprint: 'OP-1',
          claim: 'Improve naming.',
          evidence: 'The current name is broad.',
          suggestedImprovement: 'Use a narrower name.',
          evidenceRefs: [{ kind: 'plan-section', section: 'Work Plan' }],
          firstSeenPlanVersion: 0,
          lastSeenPlanVersion: 0,
        },
      ],
    });

    expect(bound).toEqual(before);
    expect(withoutOpportunity.reduction).toEqual({
      decision: 'ready',
      reasonCodes: [],
      satisfied: true,
      exhaustedLimits: [],
      unresolvedProofIds: [],
      stopReason: 'ready',
    });
    expect(withOpportunity.reduction).toEqual(withoutOpportunity.reduction);
    expect(withOpportunity.opportunities).toHaveLength(1);
    expect(applyFrozenReadinessContract(withOpportunity, contract)).toEqual(withOpportunity);
    expect(
      parseReadinessProofState(JSON.parse(JSON.stringify(withOpportunity)) as JsonValue),
    ).toEqual(withOpportunity);
  });

  it('projects provider unavailable-evidence text only through stable opaque identities', () => {
    const secret = 'DOMAIN_UNAVAILABLE_EVIDENCE_SECRET_c30614';
    const initial = lifecycleState();
    const contract = frozenContract(initial);
    const bound = bindCurrentVersion(applyFrozenReadinessContract(initial, contract));
    const riskDomains = assessedRiskDomains(contract, bound.planVersion).map((assessment) =>
      assessment.domain === 'correctness'
        ? { ...assessment, unavailableEvidence: [secret] }
        : assessment,
    );
    const reviewed = recordAdmittedCritique(bound, {
      planVersion: bound.planVersion,
      snapshot: snapshotForState(bound, 'critic'),
      scanComplete: true,
      declaredScopeVerified: true,
      materialIssueIds: [],
      issueBudgetUsed: 0,
      issueBudgetExhausted: false,
      riskDomains,
      criticCoverageGapIds: [],
      criticScopeCoverageGapIds: [],
      criticContextGapIds: [],
      boundaryChallenges: [],
      opportunities: [],
    });

    expect(JSON.stringify(reviewed.riskDomains)).toContain(secret);
    expect(JSON.stringify(reviewed.reduction)).not.toContain(secret);
    expect(reviewed.reduction.unresolvedProofIds).toContainEqual(
      expect.stringMatching(
        /^plan\.v0:required-evidence:domain-evidence-unavailable-[a-f0-9]{64}$/,
      ),
    );
  });

  it('invalidates stale review and deterministic proof when versioned bytes change', () => {
    const initial = lifecycleState();
    const contract = frozenContract(initial, {
      highRiskDomains: ['cross-repository-delivery'],
    });
    let state = bindCurrentVersion(applyFrozenReadinessContract(initial, contract));
    state = recordCleanCritique(state, contract);
    state = recordSystemProof(state, {
      binding: {
        planVersion: state.planVersion,
        planSha256: state.planSha256 ?? '',
        authoritativeDigest: state.authoritativeDigest,
      },
      passed: true,
      mismatchIds: [],
      unavailableEvidenceIds: [],
    });
    const prior = structuredClone(state);

    const rebound = bindVersionedPlan(state, {
      planVersion: 0,
      planSha256: 'd'.repeat(64),
      criticLineageDigest: 'e'.repeat(64),
      intermediateJudgeLineageDigest: 'c'.repeat(64),
    });

    expect(state).toEqual(prior);
    expect(rebound).toMatchObject({
      planSha256: 'd'.repeat(64),
      scanComplete: false,
      systemCheckPassed: false,
      systemMismatchIds: [],
      reduction: { decision: 'unable-to-decide' },
    });
    expect(rebound.lastCritiquedPlanVersion).toBeUndefined();
    expect(rebound.systemProofBinding).toBeUndefined();
    expect(rebound.sources.every((source) => source.snapshot === undefined)).toBe(true);
    expect(invalidateFullReviewProof(state).sources.every((source) => !source.snapshot)).toBe(true);
    expect(invalidateDeterministicProof(state).systemProofBinding).toBeUndefined();
  });

  it('records context and interventions immutably and preserves exact context omission proof', () => {
    const initial = lifecycleState('thorough');
    const contract = frozenContract(initial);
    const reviewed = recordCleanCritique(
      bindCurrentVersion(applyFrozenReadinessContract(initial, contract)),
      contract,
      { materialIssueIds: ['v0.C1'] },
    );
    const delivered = recordContextDelivery(reviewed, {
      role: 'critic',
      stage: 'review',
      planVersion: 0,
      mandatoryBytes: 100,
      optionalBytes: 20,
      totalInputBytes: 120,
      inputTokenLimit: 1_000,
      inputLimitSource: 'operator',
      reductions: [{ category: 'prior-critiques', bytes: 10 }],
      omittedCategories: ['topology'],
    });

    expect(delivered.contextDeliveries).toHaveLength(1);
    expect(delivered.reduction.unresolvedProofIds).toContainEqual(
      expect.stringMatching(/^context-omission-/),
    );
    expect(
      delivered.sources.find((source) => source.source === 'critic')?.snapshot,
    ).toBeUndefined();
    const intervened = recordInterventions(delivered, {
      interventionIds: ['INT-1'],
      operatorDecisionIds: ['D-2'],
    });
    expect(intervened.interventionIds).toEqual(['INT-1']);
    expect(intervened.operatorDecisionIds).toEqual(['D-2']);
    expect(
      intervened.sources.find((source) => source.source === 'critic')?.snapshot,
    ).toBeUndefined();
    expect(reviewed.sources.find((source) => source.source === 'critic')?.snapshot).toBeDefined();

    const refreshed = recordAuthoritativeContext(reviewed, {
      authoritativeDigest: 'e'.repeat(64),
      relationshipIds: ['R-2'],
    });
    expect(refreshed.authoritativeDigest).toBe('e'.repeat(64));
    expect(refreshed.relationshipIds).toEqual(['R-2']);
    expect(refreshed.sources.every((source) => source.snapshot === undefined)).toBe(true);
    expect(refreshed.systemProofBinding).toBeUndefined();
  });

  it('promotes Judge occurrence sources when admitted critic risk becomes high', () => {
    const initial = lifecycleState('thorough');
    const contract = frozenContract(initial);
    const bound = bindCurrentVersion(applyFrozenReadinessContract(initial, contract));
    const escalatedRisk = assessedRiskDomains(contract, 0).map((assessment) =>
      assessment.domain === 'correctness' ? { ...assessment, risk: 'high' as const } : assessment,
    );
    const escalated = recordAdmittedCritique(bound, {
      planVersion: 0,
      snapshot: snapshotForState(bound, 'critic'),
      scanComplete: true,
      declaredScopeVerified: true,
      materialIssueIds: [],
      issueBudgetUsed: 0,
      issueBudgetExhausted: false,
      riskDomains: escalatedRisk,
      criticCoverageGapIds: [],
      criticScopeCoverageGapIds: [],
      criticContextGapIds: [],
      boundaryChallenges: [],
      opportunities: [],
    });

    expect(
      escalated.sources
        .filter((source) => source.source.endsWith('judge'))
        .map((source) => [source.source, source.requirement.required]),
    ).toEqual([
      ['intermediate-judge', true],
      ['final-judge', false],
    ]);
    expect(escalated.reduction.reasonCodes).toContain('judge-unavailable');
    expect(escalated.reduction.reasonCodes).toContain('occurrence-source-missing');
    expect(() =>
      recordAdmittedJudgeProof(escalated, {
        stage: 'intermediate',
        snapshot: snapshotForState(escalated, 'intermediate-judge'),
        verdict: true,
        approvedPlanVersion: 0,
        materialIssueIds: [],
      }),
    ).toThrow('candidate contentDigest must be a lowercase 64-character SHA-256 digest');
    const rebound = bindVersionedPlan(escalated, {
      planVersion: 0,
      planSha256: 'a'.repeat(64),
      criticLineageDigest: 'b'.repeat(64),
      intermediateJudgeLineageDigest: 'c'.repeat(64),
    });
    expect(
      rebound.sources.find((source) => source.source === 'intermediate-judge')?.requirement,
    ).toMatchObject({
      required: true,
      expectedBinding: { candidate: { contentDigest: 'a'.repeat(64) } },
    });
    const judged = recordAdmittedJudgeProof(rebound, {
      stage: 'intermediate',
      snapshot: snapshotForState(rebound, 'intermediate-judge'),
      verdict: true,
      approvedPlanVersion: 0,
      materialIssueIds: [],
    });
    expect(judged.reduction).toMatchObject({ decision: 'ready', satisfied: true });
  });

  it('binds system, intermediate Judge, canonical, and final Judge proof to exact identities', () => {
    const initial = lifecycleState('thorough');
    const contract = frozenContract(initial, {
      highRiskDomains: ['cross-repository-delivery'],
    });
    let state = bindCurrentVersion(applyFrozenReadinessContract(initial, contract));
    state = recordCleanCritique(state, contract);

    state = recordSystemProof(state, {
      binding: {
        planVersion: 0,
        planSha256: state.planSha256 ?? '',
        authoritativeDigest: state.authoritativeDigest,
      },
      passed: true,
      mismatchIds: [],
      unavailableEvidenceIds: [],
    });
    state = recordAdmittedJudgeProof(state, {
      stage: 'intermediate',
      snapshot: snapshotForState(state, 'intermediate-judge'),
      verdict: true,
      approvedPlanVersion: 0,
      materialIssueIds: [],
    });
    const fixBinding = createOccurrenceSourceBinding(state, {
      source: 'fix-reviewer',
      candidateKind: 'fix-applied',
      contentDigest: '6'.repeat(64),
    });
    state = recordAdmittedFixReviewerProof(state, {
      required: true,
      reason: 'fix-pass-replacement-retained',
      expectedBinding: fixBinding,
      snapshot: {
        source: 'fix-reviewer',
        catalogDigest: state.catalog.digest,
        binding: fixBinding,
        occurrences: [],
      },
      materialIssueIds: [],
    });
    state = bindCanonicalPlan(state, {
      planVersion: 0,
      canonicalPlanSha256: 'd'.repeat(64),
      finalJudgeLineageDigest: 'e'.repeat(64),
      compatibleWithVersionedProof: true,
    });
    expect(state.systemProofBinding).toBeUndefined();
    state = recordSystemProof(state, {
      binding: {
        planVersion: 0,
        planSha256: 'd'.repeat(64),
        authoritativeDigest: state.authoritativeDigest,
      },
      passed: true,
      mismatchIds: [],
      unavailableEvidenceIds: [],
    });
    state = recordAdmittedJudgeProof(state, {
      stage: 'final',
      snapshot: snapshotForState(state, 'final-judge'),
      verdict: true,
      approvedPlanVersion: 0,
      materialIssueIds: [],
    });
    state = markFinalArtifactReview(state, {
      planVersion: 0,
      canonicalPlanSha256: 'd'.repeat(64),
      fresh: true,
      judgeConsistent: true,
    });

    expect(state.reduction).toMatchObject({ decision: 'ready', satisfied: true });
    expect(state.systemProofBinding).toEqual({
      planVersion: 0,
      planSha256: 'd'.repeat(64),
      authoritativeDigest: 'f'.repeat(64),
    });
    expect(
      state.sources.find((source) => source.source === 'final-judge')?.snapshot?.binding.candidate,
    ).toEqual({ kind: 'canonical-plan', planVersion: 0, contentDigest: 'd'.repeat(64) });
    expect(state.occurrenceCoverage.proofSatisfied).toBe(true);

    const resumed = invalidateFinalizationProof(state);
    expect(resumed.canonicalPlanSha256).toBeUndefined();
    expect(resumed.sources.find((source) => source.source === 'fix-reviewer')?.requirement).toEqual(
      { required: false, reason: 'not-evaluated-for-current-candidate' },
    );
    expect(
      resumed.sources.find((source) => source.source === 'fix-reviewer')?.snapshot,
    ).toBeUndefined();
    expect(resumed.sources.find((source) => source.source === 'final-judge')?.requirement).toEqual({
      required: false,
      reason: 'canonical-plan-not-bound',
    });
    expect(
      resumed.sources.find((source) => source.source === 'intermediate-judge')?.snapshot,
    ).toBeDefined();
    expect(resumed.judgeEvaluatedPlanVersion).toBeUndefined();
    expect(resumed.judgeReady).toBeUndefined();
  });

  it('replaces the catalog on an admitted creator update and clears every stale proof source', () => {
    const initial = lifecycleState();
    const contract = frozenContract(initial);
    const reviewed = recordCleanCritique(
      bindCurrentVersion(applyFrozenReadinessContract(initial, contract)),
      contract,
      { materialIssueIds: ['v0.C1'] },
    );
    const nextCatalog = createReadinessProofCatalog({
      expectedPlanVersion: 1,
      invariants: [{ invariantId: 'I-1', occurrenceIds: ['O-1'] }],
      materialIssueIds: ['M-1'],
    });
    const invariants: readonly ReadinessInvariantRecord[] = [
      {
        id: 'I-1',
        sourceFinding: 'F-1',
        statement: 'Every generated artifact remains consistent.',
        occurrences: [{ id: 'O-1', dimension: 'artifact', subject: 'final plan' }],
      },
    ];
    const findings = [
      {
        id: 'F-1',
        issueRef: 'v0.M-1',
        introducedPlanVersion: 1,
        severity: 'major' as const,
        claim: 'Artifacts can diverge.',
        disposition: {
          scope: 'cross-cutting' as const,
          rationale: 'The concern spans every output.',
          evidenceRefs: [],
        },
      },
    ];
    const transitionReceipt = {
      schemaVersion: 1 as const,
      fromPlanVersion: 0,
      toPlanVersion: 1,
      fromCatalogDigest: reviewed.catalog.digest,
      expectedIssuesDigest: 'a'.repeat(64),
      updateDigest: 'b'.repeat(64),
      candidateDigest: 'c'.repeat(64),
      nextCatalogDigest: nextCatalog.digest,
      admittedFactsDigest: 'd'.repeat(64),
      admittedCriticIssueRefsDigest: canonicalJsonSha256(reviewed.admittedCriticIssueRefs),
    };
    const before = structuredClone(reviewed);

    const updated = recordAdmittedCreatorUpdate(reviewed, {
      fromPlanVersion: 0,
      nextCatalog,
      findings,
      invariants,
      materialRevisionProofGapIds: [],
      transitionReceipt,
    });

    expect(reviewed).toEqual(before);
    expect(updated).toMatchObject({
      planVersion: 1,
      catalog: { expectedPlanVersion: 1, materialIssueIds: ['M-1'] },
      invariants,
      scanComplete: false,
      reduction: { decision: 'unable-to-decide' },
    });
    expect(updated.planSha256).toBeUndefined();
    expect(updated.admittedCriticIssueRefs).toEqual(['v0.C1']);
    expect(updated.sources.every((source) => source.snapshot === undefined)).toBe(true);
    expect(updated.occurrenceCoverage.unresolvedOccurrenceIds).toEqual(['O-1']);
    expect(updated.reduction.unresolvedProofIds).toContain('I-1');

    const forged = JSON.parse(JSON.stringify(updated)) as {
      admittedCriticIssueRefs: string[];
    };
    forged.admittedCriticIssueRefs = ['v0.C999'];
    expect(() => parseReadinessProofState(forged as JsonValue)).toThrow(
      'admitted critic issue history does not match the creator receipt',
    );

    expect(() =>
      recordAdmittedCreatorUpdate(reviewed, {
        fromPlanVersion: 0,
        nextCatalog,
        findings,
        invariants,
        materialRevisionProofGapIds: [],
        transitionReceipt: { ...transitionReceipt, updateDigest: 'A'.repeat(64) },
      }),
    ).toThrow('creator transition receipt is invalid');

    for (const digestKey of [
      'fromCatalogDigest',
      'expectedIssuesDigest',
      'updateDigest',
      'candidateDigest',
      'nextCatalogDigest',
      'admittedFactsDigest',
      'admittedCriticIssueRefsDigest',
    ] as const) {
      const malformed = JSON.parse(JSON.stringify(updated)) as {
        creatorTransitionReceipt: Record<string, string>;
      };
      malformed.creatorTransitionReceipt[digestKey] = 'A'.repeat(64);
      expect(() => parseReadinessProofState(malformed as JsonValue)).toThrow(
        `creatorTransitionReceipt.${digestKey} must be a lowercase 64-character SHA-256 digest`,
      );
    }
  });

  it('keeps material revision work source-owned during selective invalidation', () => {
    const initial = lifecycleState('thorough');
    const contract = frozenContract(initial, { highRiskDomains: ['correctness'] });
    let state = recordCleanCritique(
      bindCurrentVersion(applyFrozenReadinessContract(initial, contract)),
      contract,
    );
    const fixBinding: OccurrenceSourceBinding = {
      candidate: { kind: 'fix-applied', planVersion: 0, contentDigest: '6'.repeat(64) },
      lineage: { evaluationStage: 'fix-applied-review', lineageDigest: '7'.repeat(64) },
    };
    state = recordAdmittedFixReviewerProof(state, {
      required: true,
      reason: 'fix-pass-replacement-retained',
      expectedBinding: fixBinding,
      snapshot: {
        source: 'fix-reviewer',
        catalogDigest: state.catalog.digest,
        binding: fixBinding,
        occurrences: [],
      },
      materialIssueIds: ['FIX-MAJOR'],
    });
    state = recordAdmittedJudgeProof(state, {
      stage: 'intermediate',
      snapshot: snapshotForState(state, 'intermediate-judge'),
      verdict: false,
      materialIssueIds: ['JUDGE-MAJOR'],
    });

    expect(state.currentActionableIssues).toEqual(['FIX-MAJOR', 'JUDGE-MAJOR']);
    const withoutFix = invalidateOccurrenceCoverageSource(state, 'fix-reviewer');
    expect(withoutFix.currentActionableIssues).toEqual(['JUDGE-MAJOR']);
    expect(withoutFix.reduction.decision).toBe('revision-required');
  });

  it('passes exact critic scope/context gap IDs into reduction and preserves priority', () => {
    const initial = lifecycleState();
    const contract = frozenContract(initial);
    const reviewed = recordCleanCritique(
      bindCurrentVersion(applyFrozenReadinessContract(initial, contract)),
      contract,
      {
        criticScopeCoverageGapIds: ['plan.v0:scope-coverage-incomplete'],
        criticContextGapIds: ['plan.v0:context-unconsidered:original-scope'],
      },
    );

    expect(reviewed.reduction).toMatchObject({
      decision: 'unable-to-decide',
      reasonCodes: ['critic-context-incomplete', 'critic-scope-coverage-incomplete'],
      unresolvedProofIds: [
        'plan.v0:context-unconsidered:original-scope',
        'plan.v0:scope-coverage-incomplete',
      ],
    });
    const limited = addReadinessLimit(
      recordCleanCritique(
        bindCurrentVersion(applyFrozenReadinessContract(initial, contract)),
        contract,
      ),
      {
        limit: 'iteration-cap',
        unresolvedProofId: 'plan.v0:iteration-cap',
      },
    );
    expect(limited.reduction.decision).toBe('limits-exhausted');
    const issueBudgetLimited = addReadinessLimit(
      recordCleanCritique(
        bindCurrentVersion(applyFrozenReadinessContract(initial, contract)),
        contract,
      ),
      { limit: 'issue-budget' },
    );
    expect(issueBudgetLimited.issueBudget.exhausted).toBe(true);
    expect(issueBudgetLimited.exhaustedLimits).toContain('issue-budget');
    const challenged = addBoundaryChallenge(limited, {
      id: 'BC-1',
      kind: 'scope-expansion',
      claim: 'The requested scope expanded.',
      rationale: 'The new scope is not frozen.',
      evidenceRefs: [],
      planVersion: 0,
    });
    expect(challenged.reduction).toMatchObject({
      decision: 'unable-to-decide',
      reasonCodes: ['boundary-challenge'],
    });
  });
});
