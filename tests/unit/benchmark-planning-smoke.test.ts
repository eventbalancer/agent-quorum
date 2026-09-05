import { createHash } from 'node:crypto';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ajvModule from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { admitFinalPlan } from '../../src/core/plan-admission.js';
import { readRunRecords } from '../../src/core/run-store.js';
import {
  collectPlanningArtifacts,
  parsePlanningArtifactBundle,
  parsePlanningArtifactProjection,
  planningArtifactsNeedDecoder,
  withPlanningArtifactProjection,
} from '../../src/delivery/evidence-artifacts.js';
import {
  adoptReviewedEvidenceDecoder,
  readApprovedEvidenceDecoder,
} from '../../src/delivery/evidence-decoder-registry.js';
import {
  evidenceDecoderAcceptance,
  evidenceDecoderFixtureDigest,
  type EvidenceDecoderExecutor,
} from '../../src/delivery/evidence-decoder.js';
import { admitDeliveryPlanArtifacts, runDeliveryPlan } from '../../src/delivery/plan-runner.js';
import { buildSystemContext } from '../../src/core/system-context.js';
import {
  DAY_LIMIT_MS,
  DELIVERY_OPERATIONS,
  ISSUE_LIMIT_MS,
  REPAIR_LIMIT,
  type DeliveryIssue,
  type Mandate,
  digest,
} from '../../src/delivery/contract.js';
import { DECODER_NEGATIVE_CASES, type ReviewReceipt } from '../../src/delivery/evidence.js';
import { validateLiveExecutionSummary } from '../../src/delivery/live-evidence.js';
import { canonicalJsonSha256, fileSha256 } from '../../src/core/digest.js';
import { admitCritique } from '../../src/core/readiness-admission.js';
import type { JsonValue } from '../../src/core/json.js';
import {
  liveProvenancePath,
  type LiveProviderCall,
  type LiveProviderProvenance,
} from '../../src/delivery/live-provenance.js';
import {
  admitProviderArtifactBindings,
  assertProviderProjection,
  parseLiveProviderProvenance,
} from '../../src/delivery/live-provenance-admission.js';
import { isAlive } from '../../src/runtime/proc.js';
import {
  executeSmokeScenario,
  evaluateSmokeWithDecoder,
  runPlanningSmoke,
  type PlanningSmokeDependencies,
  type SmokeScenarioExecution,
} from '../../scripts/benchmark-planning/smoke-run.js';
import { readSmokeAttempts } from '../../scripts/benchmark-planning/smoke-attempts.js';
import { BENCHMARK_ROOT } from '../../scripts/benchmark-planning/benchmark.js';
import type {
  PlanningSmokeResults,
  PlanningSmokeSentinel,
} from '../../scripts/benchmark-planning/model.js';
import {
  evaluatePlanningSmokeSentinel,
  loadPlanningSmoke,
  validatePlanningSmoke,
} from '../../scripts/benchmark-planning/smoke.js';
import { qualityMatrix } from '../../src/core/quality.js';
import {
  RISK_DOMAINS,
  RETAINED_CONTEXT_CATEGORIES,
  buildReadinessContract,
  writeFrozenReadinessContract,
  type ReadinessContract,
} from '../../src/core/readiness-contract.js';
import {
  applyFrozenReadinessContract,
  bindCanonicalPlan,
  bindVersionedPlan,
  createOccurrenceSourceBinding,
  createReadinessProofCatalog,
  createReadinessProofState,
  markFinalArtifactReview,
  projectOccurrenceCoverage,
  recordAdmittedCritique,
  recordAdmittedFixReviewerProof,
  recordAdmittedJudgeProof,
  type OccurrenceCoverageSnapshot,
  type OccurrenceSource,
  type ReadinessProofState,
} from '../../src/core/readiness-proof.js';
import { writeReadinessProofState } from '../../src/core/readiness-store.js';
import type { FinalProjection, Quality } from '../../src/types.js';

const Ajv2020 = ajvModule.default;
const INVARIANT_ID = 'I-smoke-exactness';
const OCCURRENCE_ID = 'O-smoke-exactness';
const SOURCE_TEXT = 'Source planning input\n';
const SOURCE_DIGEST = sha256(SOURCE_TEXT);
const SYSTEM_DIGEST = '2'.repeat(64);

let temporaryRoot: string;

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-planning-smoke.'));
});

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function sentinel(id: string): PlanningSmokeSentinel {
  const selected = loadPlanningSmoke().manifest.sentinels.find((entry) => entry.id === id);
  if (selected === undefined) {
    throw new Error(`missing smoke sentinel fixture: ${id}`);
  }
  return selected;
}

function baseWorkDir(name: string): string {
  const workDir = path.join(temporaryRoot, name, 'run');
  mkdirSync(path.join(temporaryRoot, name, 'state', 'runs'), { recursive: true });
  mkdirSync(workDir, { recursive: true });
  writeJson(path.join(workDir, 'readiness-assessment.initial.json'), { admitted: true });
  return workDir;
}

function frozenContract(
  quality: Quality,
  highRisk: boolean,
  sourceDigest = SOURCE_DIGEST,
  systemDigest = SYSTEM_DIGEST,
  iterationLimit = 3,
): ReadinessContract {
  return buildReadinessContract({
    assessment: {
      boundary: {
        goal: 'Prove the smoke plan is implementation-ready.',
        in_scope: ['current repository'],
        out_of_scope: [],
        constraints: ['preserve exact artifact identity'],
      },
      domain_assessments: RISK_DOMAINS.map((domain) => ({
        domain,
        applicability:
          domain === 'correctness' || (highRisk && domain === 'data-migrations')
            ? 'applicable'
            : 'not-applicable',
        risk: highRisk && domain === 'data-migrations' ? 'high' : 'standard',
        rationale: `${domain} smoke assessment`,
        evidence_refs: [],
      })),
      material_questions: [],
    },
    sourceDigest,
    systemDigest,
    quality,
    iterationLimit,
    issueBudget: 8,
    operatorDecisionIds: [],
  });
}

function snapshotFor(
  state: ReadinessProofState,
  source: OccurrenceSource,
): OccurrenceCoverageSnapshot {
  const slot = state.sources.find((candidate) => candidate.source === source);
  if (slot?.requirement.required !== true) {
    throw new Error(`${source} must be required by the smoke fixture`);
  }
  return {
    source,
    catalogDigest: state.catalog.digest,
    binding: slot.requirement.expectedBinding,
    occurrences: [
      {
        invariantId: INVARIANT_ID,
        occurrenceId: OCCURRENCE_ID,
        disposition: 'satisfied',
        evidenceGrounded: true,
      },
    ],
  };
}

function reviewedState(options: {
  readonly contract: ReadinessContract;
  readonly planVersion: number;
  readonly planSha256: string;
  readonly highRisk: boolean;
}): ReadinessProofState {
  const quality = options.highRisk ? 'balanced' : 'quick';
  let state = createReadinessProofState({
    quality,
    matrix: qualityMatrix(quality),
    mode: options.highRisk ? 'plan' : 'prompt',
    sourceDigest: options.contract.sourceDigest,
    authoritativeDigest: options.contract.systemDigest,
    relationshipIds: [],
    maxIters: options.contract.appetite.iterationLimit,
    trustedCatalog: createReadinessProofCatalog({
      expectedPlanVersion: options.planVersion,
      invariants: [{ invariantId: INVARIANT_ID, occurrenceIds: [OCCURRENCE_ID] }],
      materialIssueIds: [],
    }),
    invariants: [
      {
        id: INVARIANT_ID,
        sourceFinding: `catalog:${INVARIANT_ID}`,
        statement: 'Every durable projection preserves exact occurrence proof.',
        occurrences: [
          {
            id: OCCURRENCE_ID,
            dimension: 'durable-projection',
            subject: 'planning smoke',
          },
        ],
      },
    ],
  });
  state = applyFrozenReadinessContract(state, options.contract);
  const criticBinding = createOccurrenceSourceBinding(state, {
    source: 'critic',
    candidateKind: 'versioned-plan',
    contentDigest: options.planSha256,
  });
  const intermediateBinding = options.highRisk
    ? createOccurrenceSourceBinding(state, {
        source: 'intermediate-judge',
        candidateKind: 'versioned-plan',
        contentDigest: options.planSha256,
      })
    : undefined;
  state = bindVersionedPlan(state, {
    planVersion: options.planVersion,
    planSha256: options.planSha256,
    criticLineageDigest: criticBinding.lineage.lineageDigest,
    ...(intermediateBinding === undefined
      ? {}
      : { intermediateJudgeLineageDigest: intermediateBinding.lineage.lineageDigest }),
  });
  state = recordAdmittedCritique(state, {
    planVersion: options.planVersion,
    snapshot: snapshotFor(state, 'critic'),
    scanComplete: true,
    declaredScopeVerified: true,
    materialIssueIds: [],
    issueBudgetUsed: 0,
    issueBudgetExhausted: false,
    riskDomains: options.contract.domainAssessments.map((assessment) => ({
      ...assessment,
      complete: true,
      unavailableEvidence: [],
      lastAssessedPlanVersion: options.planVersion,
    })),
    criticCoverageGapIds: [],
    criticScopeCoverageGapIds: [],
    criticContextGapIds: [],
    boundaryChallenges: [],
    opportunities: [],
  });
  if (options.highRisk) {
    state = recordAdmittedJudgeProof(state, {
      stage: 'intermediate',
      snapshot: snapshotFor(state, 'intermediate-judge'),
      verdict: true,
      approvedPlanVersion: options.planVersion,
      materialIssueIds: [],
    });
  }
  return state;
}

type FixReviewerMode = 'required' | 'exempt' | 'unsupported-exempt';

function canonicalState(
  reviewed: ReadinessProofState,
  canonicalPlanSha256: string,
  fixReviewer: FixReviewerMode,
): ReadinessProofState {
  let state = reviewed;
  if (fixReviewer === 'required') {
    const binding = createOccurrenceSourceBinding(state, {
      source: 'fix-reviewer',
      candidateKind: 'fix-applied',
      contentDigest: '3'.repeat(64),
    });
    state = recordAdmittedFixReviewerProof(state, {
      required: true,
      reason: 'fix-pass-replacement-retained',
      expectedBinding: binding,
      snapshot: {
        source: 'fix-reviewer',
        catalogDigest: state.catalog.digest,
        binding,
        occurrences: [
          {
            invariantId: INVARIANT_ID,
            occurrenceId: OCCURRENCE_ID,
            disposition: 'satisfied',
            evidenceGrounded: true,
          },
        ],
      },
      materialIssueIds: [],
    });
  } else {
    state = recordAdmittedFixReviewerProof(state, {
      required: false,
      reason: fixReviewer === 'exempt' ? 'no-findings' : 'not-evaluated-for-current-candidate',
    });
  }
  const judgeRequired = state.riskDomains.some(
    (domain) => domain.applicability === 'applicable' && domain.risk === 'high',
  );
  const finalBinding = judgeRequired
    ? createOccurrenceSourceBinding(state, {
        source: 'final-judge',
        candidateKind: 'canonical-plan',
        contentDigest: canonicalPlanSha256,
      })
    : undefined;
  state = bindCanonicalPlan(state, {
    planVersion: state.planVersion,
    canonicalPlanSha256,
    ...(finalBinding === undefined
      ? {}
      : { finalJudgeLineageDigest: finalBinding.lineage.lineageDigest }),
    compatibleWithVersionedProof: true,
  });
  if (judgeRequired) {
    state = recordAdmittedJudgeProof(state, {
      stage: 'final',
      snapshot: snapshotFor(state, 'final-judge'),
      verdict: true,
      approvedPlanVersion: state.planVersion,
      materialIssueIds: [],
    });
  }
  return markFinalArtifactReview(state, {
    planVersion: state.planVersion,
    canonicalPlanSha256,
    fresh: true,
    judgeConsistent: true,
  });
}

function finalProjection(
  workDir: string,
  proof: ReadinessProofState,
  highRisk: boolean,
): FinalProjection {
  const proofArtifactPath = path.join(workDir, 'convergence.final.json');
  const finalJudge = proof.sources.find((candidate) => candidate.source === 'final-judge');
  const finalJudgeBinding = finalJudge?.snapshot?.binding;
  return {
    status: 'clean',
    reasons: [],
    structuralStatus: 'clean',
    structuralReason: '',
    artifactPath: proofArtifactPath,
    readiness: {
      proofArtifactPath,
      planVersion: proof.planVersion,
      canonicalPlanSha256: proof.canonicalPlanSha256 ?? '',
      decision: proof.reduction.decision,
      reasonCodes: proof.reduction.reasonCodes,
      satisfied: proof.reduction.satisfied,
      exhaustedLimits: proof.reduction.exhaustedLimits,
      unresolvedProofIds: proof.reduction.unresolvedProofIds,
      applicableRiskDomains: proof.riskDomains
        .filter((domain) => domain.applicability === 'applicable')
        .map((domain) => domain.domain),
      highRiskDomains: proof.riskDomains
        .filter((domain) => domain.applicability === 'applicable' && domain.risk === 'high')
        .map((domain) => domain.domain),
      opportunityCount: proof.opportunities.length,
      occurrenceCoverage: projectOccurrenceCoverage(proof),
    },
    judge: highRisk
      ? {
          required: true,
          allowed: true,
          evaluated: true,
          available: true,
          candidateUnchanged: true,
          verdict: true,
          rationale: 'final-judge-ready',
          binding:
            finalJudgeBinding ??
            (() => {
              throw new Error('final Judge binding is unavailable');
            })(),
          metadataPath: path.join(workDir, 'judge.final.meta.json'),
        }
      : {
          required: false,
          allowed: false,
          evaluated: false,
          available: false,
          candidateUnchanged: true,
          verdict: null,
          rationale: 'standard-risk-judge-exempt',
        },
  };
}

interface ReadyArtifacts {
  readonly proof: ReadinessProofState;
  readonly final: FinalProjection;
  readonly digest: string;
  readonly runRecordFile: string;
}

function authenticCritique(state: ReadinessProofState, version: number, highRisk: boolean): object {
  const evidence = [{ kind: 'file-line', path: `plan.v${version}.md`, line: 1 }];
  const material = highRisk && version === 0;
  return {
    plan_version: version,
    summary: 'Supervised provider assessment',
    review: {
      considered_context: [...RETAINED_CONTEXT_CATEGORIES],
      scope_coverage: [highRisk ? 'direct-plan-scope' : 'original-scope'],
      issue_budget: { limit: state.issueBudget.limit, used: material ? 1 : 0, exhausted: false },
      scan_complete: true,
      unresolved_coverage: [],
      invariant_assessments: state.catalog.invariants.map((invariant) => ({
        invariant_id: invariant.invariantId,
        complete: true,
        occurrences: invariant.occurrenceIds.map((id) => ({
          occurrence_id: id,
          disposition: 'satisfied',
          evidence_refs: evidence,
        })),
      })),
    },
    domain_assessments: state.riskDomains.map((domain) => ({
      domain: domain.domain,
      applicability: domain.applicability,
      risk: domain.risk,
      complete: true,
      rationale: domain.rationale,
      unavailable_evidence: [],
      evidence_refs: evidence,
    })),
    boundary_challenges: [],
    opportunities: [],
    issues: material
      ? [
          {
            id: 'C1',
            addresses: null,
            severity: 'major',
            category: 'correctness',
            claim: 'Seeded missing migration guard',
            evidence: 'Original direct plan',
            evidence_refs: evidence,
            suggested_fix: 'Add the migration guard',
            confidence: 1,
            duplicate_of: null,
          },
        ]
      : [],
  };
}

function authenticJudge(state: ReadinessProofState, candidate: string): object {
  return {
    ready: true,
    rationale: 'The candidate is ready.',
    revision_issue: null,
    coverage_complete: true,
    unresolved_occurrence_ids: [],
    invariant_assessments: state.catalog.invariants.map((invariant) => ({
      invariant_id: invariant.invariantId,
      occurrences: invariant.occurrenceIds.map((id) => ({
        occurrence_id: id,
        disposition: 'satisfied',
        evidence_refs: [{ kind: 'file-line', path: candidate, line: 1 }],
      })),
    })),
  };
}

function writeReadyArtifacts(
  workDir: string,
  options: {
    readonly planVersion: number;
    readonly highRisk: boolean;
    readonly fixReviewer?: FixReviewerMode;
    readonly sourceText?: string;
    readonly systemDigest?: string;
    readonly authentic?: boolean;
  },
): ReadyArtifacts {
  const sourceText = options.sourceText ?? SOURCE_TEXT;
  writeFileSync(path.join(workDir, 'input.md'), sourceText);
  const quality: Quality = options.highRisk ? 'balanced' : 'quick';
  const contract = frozenContract(
    quality,
    options.highRisk,
    sha256(sourceText),
    options.systemDigest ?? SYSTEM_DIGEST,
    options.authentic === true && !options.highRisk ? 2 : 3,
  );
  writeFrozenReadinessContract(path.join(workDir, 'readiness-contract.json'), contract);
  const finalPlan = '---\nstatus: clean\n---\n\n# Final smoke plan\n';
  const digest = sha256(finalPlan);
  writeFileSync(path.join(workDir, 'plan.final.md'), finalPlan);
  let finalReviewed: ReadinessProofState | undefined;
  for (let version = 0; version <= options.planVersion; version += 1) {
    const plan =
      version === options.planVersion
        ? finalPlan
        : options.authentic === true
          ? sourceText
          : `# Smoke plan v${String(version)}\n`;
    writeFileSync(path.join(workDir, `plan.v${String(version)}.md`), plan);
    let reviewed = reviewedState({
      contract,
      planVersion: version,
      planSha256: sha256(plan),
      highRisk: options.highRisk,
    });
    const critique =
      options.authentic === true
        ? authenticCritique(reviewed, version, options.highRisk)
        : { issues: options.highRisk && version === 0 ? [{ id: 'C1', severity: 'major' }] : [] };
    writeJson(path.join(workDir, `critique.v${String(version)}.json`), critique);
    if (options.authentic === true) {
      reviewed = recordAdmittedCritique(
        reviewed,
        admitCritique({
          value: critique as JsonValue,
          catalog: reviewed.catalog,
          binding: createOccurrenceSourceBinding(reviewed, {
            source: 'critic',
            candidateKind: 'versioned-plan',
            contentDigest: sha256(plan),
          }),
          evidenceContext: {
            work: workDir,
            projectRoot: temporaryRoot,
            planVersion: version,
            candidateContent: plan,
            candidatePath: path.join(workDir, `plan.v${version}.md`),
          },
          expectedScopeToken: options.highRisk ? 'direct-plan-scope' : 'original-scope',
          issueBudgetLimit: reviewed.issueBudget.limit,
          currentRiskDomains: reviewed.riskDomains,
          admittedPriorIssueRefs: [],
        }),
      );
      if (options.highRisk) {
        reviewed = recordAdmittedJudgeProof(reviewed, {
          stage: 'intermediate',
          snapshot: snapshotFor(reviewed, 'intermediate-judge'),
          verdict: true,
          approvedPlanVersion: version,
          materialIssueIds: [],
        });
      }
    }
    writeReadinessProofState(path.join(workDir, `convergence.v${String(version)}.json`), reviewed);
    if (version < options.planVersion) {
      const metadata =
        options.authentic === true
          ? { plan_version: version + 1, issues: [], applied: ['C1'], rejected_append: [] }
          : { applied: ['C1'] };
      writeJson(
        path.join(workDir, `update.v${String(version)}.json`),
        options.authentic === true ? { ...metadata, plan_markdown: finalPlan } : metadata,
      );
      writeJson(path.join(workDir, `update-meta.v${String(version)}.json`), metadata);
    }
    finalReviewed = reviewed;
  }
  if (finalReviewed === undefined) {
    throw new Error('final reviewed smoke state is unavailable');
  }
  const proof = canonicalState(
    finalReviewed,
    digest,
    options.fixReviewer ?? (options.highRisk && options.authentic !== true ? 'required' : 'exempt'),
  );
  if (proof.reduction.decision !== 'ready') {
    throw new Error(`smoke fixture did not reach ready: ${proof.reduction.stopReason}`);
  }
  const proofFile = path.join(workDir, 'convergence.final.json');
  writeReadinessProofState(proofFile, proof);
  const final = finalProjection(workDir, proof, options.highRisk);
  if (options.highRisk) {
    const finalSource = final.readiness.occurrenceCoverage.sources.find(
      (source) => source.source === 'final-judge',
    );
    writeJson(
      path.join(workDir, `judge.v${String(options.planVersion)}.json`),
      options.authentic === true
        ? authenticJudge(proof, `plan.v${options.planVersion}.md`)
        : { ready: true },
    );
    writeJson(
      path.join(workDir, 'judge.final.json'),
      options.authentic === true ? authenticJudge(proof, 'plan.final.md') : { ready: true },
    );
    writeJson(path.join(workDir, 'judge.final.meta.json'), {
      schemaVersion: 2,
      canonicalPlan: 'plan.final.md',
      planVersion: proof.planVersion,
      planSha256: digest,
      observedPlanSha256: digest,
      readinessContractDigest: contract.contractDigest,
      catalogDigest: proof.catalog.digest,
      source: 'final-judge',
      binding: final.judge.binding,
      evaluated: true,
      available: true,
      candidateUnchanged: true,
      ready: true,
      rationale: final.judge.rationale,
      occurrenceProof: {
        coverageComplete: true,
        satisfied: true,
        unresolvedOccurrenceIds: [],
        violatedOccurrenceIds: [],
        occurrences: finalSource?.snapshot?.occurrences,
        materialIssueIds: [],
      },
      verdictArtifact: 'judge.final.json',
    });
  }
  const runId = `rsmoke-${path.basename(path.dirname(workDir))}`;
  const runRecordFile = path.join(path.dirname(workDir), 'state', 'runs', `${runId}.json`);
  writeJson(runRecordFile, {
    schemaVersion: 1,
    runId,
    name: path.basename(path.dirname(workDir)),
    pid: 4242,
    pgid: '4242',
    procStartToken: 'smoke-process',
    mode: options.highRisk ? 'plan' : 'prompt',
    inputPath: path.join(workDir, 'input.md'),
    workDir,
    logPath: path.join(workDir, 'run.log'),
    plansDir: path.dirname(workDir),
    startedAt: '2026-08-23T00:00:00.000Z',
    quality,
    state: 'finished',
    endedAt: '2026-08-23T00:01:00.000Z',
    exitCode: 0,
    final,
  });
  writeJson(path.join(path.dirname(workDir), 'api-result.json'), {
    schemaVersion: 1,
    exitCode: 0,
    workDir,
    final,
  });
  return { proof, final, digest, runRecordFile };
}

describe('planning live smoke manifest', () => {
  it('pins one quick standard prompt and one balanced high-risk revision sentinel', () => {
    const { manifest } = loadPlanningSmoke();

    expect(manifest.sentinels).toHaveLength(2);
    expect(manifest.sentinels).toMatchObject([
      {
        id: 'standard-create-ready',
        risk: 'standard',
        inputMode: 'prompt',
        quality: 'quick',
        expected: { judge: 'forbidden', minimumPlanVersion: 0 },
      },
      {
        id: 'high-revise-judge-ready',
        risk: 'high',
        inputMode: 'plan',
        quality: 'balanced',
        expected: { judge: 'required', minimumPlanVersion: 1 },
      },
    ]);
    expect(
      readFileSync(path.join(BENCHMARK_ROOT, 'smoke/high-revise-judge-ready.plan.md'), 'utf8'),
    ).toContain('without checking their target paths or relative order');
  });

  it('accepts the standard schema-3 create-to-ready flow with explicit Judge exemption', () => {
    const workDir = baseWorkDir('standard');
    writeReadyArtifacts(workDir, { planVersion: 0, highRisk: false });

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('standard-create-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result).toMatchObject({
      passed: true,
      decision: 'ready',
      critiqueIterations: 1,
      planVersion: 0,
      failures: [],
    });
  });

  it('accepts exact revision, required fix-reviewer, and schema-2 Judge proof', () => {
    const workDir = baseWorkDir('high');
    writeReadyArtifacts(workDir, { planVersion: 1, highRisk: true });

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('high-revise-judge-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result).toMatchObject({
      passed: true,
      decision: 'ready',
      critiqueIterations: 2,
      planVersion: 1,
      failures: [],
    });
  });

  it('accepts a workdir alias for physically identical durable paths', () => {
    const workDir = baseWorkDir('aliased-standard');
    writeReadyArtifacts(workDir, { planVersion: 0, highRisk: false });
    const aliasedRoot = path.join(temporaryRoot, 'aliased-root');
    symlinkSync(path.dirname(workDir), aliasedRoot, 'dir');

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('standard-create-ready'),
      outputDir: temporaryRoot,
      workDir: path.join(aliasedRoot, 'run'),
      exitCode: 0,
    });

    expect(result).toMatchObject({
      passed: true,
      decision: 'ready',
      failures: [],
    });
  });

  it('rejects legacy proof, contract, Judge-metadata, and run-record schema versions', () => {
    const workDir = baseWorkDir('legacy');
    const artifacts = writeReadyArtifacts(workDir, { planVersion: 1, highRisk: true });
    for (const file of [
      path.join(workDir, 'convergence.final.json'),
      path.join(workDir, 'readiness-contract.json'),
      path.join(workDir, 'judge.final.meta.json'),
    ]) {
      const value = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      value.schemaVersion = 1;
      writeJson(file, value);
    }
    const runRecord = JSON.parse(readFileSync(artifacts.runRecordFile, 'utf8')) as Record<
      string,
      unknown
    >;
    runRecord.schemaVersion = 0;
    writeJson(artifacts.runRecordFile, runRecord);

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('high-revise-judge-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'final readiness proof is missing, corrupt, or not schema 3',
        'frozen readiness contract is missing, corrupt, or not schema 2',
        'current schema-1 run record with FinalProjection is missing',
      ]),
    );
  });

  it('rejects proof/public artifact disagreement and unsupported fix-reviewer exemption', () => {
    const workDir = baseWorkDir('disagreement');
    writeReadyArtifacts(workDir, { planVersion: 0, highRisk: false });
    const contract = frozenContract('quick', false);
    const finalPlan = readFileSync(path.join(workDir, 'plan.final.md'), 'utf8');
    const reviewed = reviewedState({
      contract,
      planVersion: 0,
      planSha256: sha256(finalPlan),
      highRisk: false,
    });
    const alternate = canonicalState(reviewed, sha256(finalPlan), 'unsupported-exempt');
    writeReadinessProofState(path.join(workDir, 'convergence.final.json'), alternate);

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('standard-create-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'durable occurrence coverage disagrees with the schema-3 proof',
        'fix-reviewer exemption is unsupported or carries stale proof',
      ]),
    );
  });

  it('rejects disagreement between the in-process API and durable projection', () => {
    const workDir = baseWorkDir('api-disagreement');
    const artifacts = writeReadyArtifacts(workDir, { planVersion: 0, highRisk: false });
    writeJson(path.join(path.dirname(workDir), 'api-result.json'), {
      schemaVersion: 1,
      exitCode: 0,
      workDir,
      final: {
        ...artifacts.final,
        status: 'needs-review',
      },
    });

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('standard-create-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain('in-process API and durable final projections disagree');
  });

  it('rejects non-schema-2 final Judge metadata without a compatibility fallback', () => {
    const workDir = baseWorkDir('judge-metadata');
    writeReadyArtifacts(workDir, { planVersion: 1, highRisk: true });
    const metadataFile = path.join(workDir, 'judge.final.meta.json');
    const metadata = JSON.parse(readFileSync(metadataFile, 'utf8')) as Record<string, unknown>;
    metadata.schemaVersion = 1;
    writeJson(metadataFile, metadata);

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('high-revise-judge-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toContain(
      'schema-2 final Judge metadata disagrees with canonical proof',
    );
  });

  it('fails when the high-risk path skips revision and required Judge proof', () => {
    const workDir = baseWorkDir('incomplete-high');
    writeReadyArtifacts(workDir, { planVersion: 0, highRisk: false });

    const result = evaluatePlanningSmokeSentinel({
      sentinel: sentinel('high-revise-judge-ready'),
      outputDir: temporaryRoot,
      workDir,
      exitCode: 0,
    });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual(
      expect.arrayContaining([
        'too few exact-version critic passes',
        'required plan revision was not produced',
        'initial critic did not report the seeded material issue',
        'high-risk sentinel has no applicable high-risk domain',
        'required intermediate/final Judge proof is incomplete',
        'intermediate Judge artifact is missing',
        'final Judge proof is missing',
      ]),
    );
  });

  it('keeps smoke results compatible with the committed schema', () => {
    const schema = JSON.parse(
      readFileSync(path.join(BENCHMARK_ROOT, 'smoke-results.schema.json'), 'utf8'),
    ) as object;
    const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
    const results: PlanningSmokeResults = {
      schemaVersion: 1,
      suiteId: 'bounded-readiness-smoke-v1',
      workspaceRevision: 'a'.repeat(40),
      providerConfigSha256: 'b'.repeat(64),
      passed: true,
      tasks: [
        {
          taskId: 'standard-create-ready',
          passed: true,
          decision: 'ready',
          critiqueIterations: 1,
          planVersion: 0,
          exitCode: 0,
          failures: [],
          finalPlan: 'standard-create-ready/run/plan.final.md',
          finalPlanSha256: 'c'.repeat(64),
        },
      ],
    };

    expect(validate(results), JSON.stringify(validate.errors)).toBe(true);
  });
});

describe('strict final design plan admission', () => {
  it('admits exact current ready evidence independently from the planning exit code', () => {
    const workDir = baseWorkDir('admission');
    writeReadyArtifacts(workDir, { planVersion: 0, highRisk: false });
    const record = readRunRecords(path.join(path.dirname(workDir), 'state'))[0];
    if (record === undefined) {
      throw new Error('fixture record missing');
    }
    expect(
      admitFinalPlan({
        workDir,
        record,
        expectedSourceDigest: SOURCE_DIGEST,
        expectedAuthoritativeDigest: SYSTEM_DIGEST,
      }).admitted,
    ).toBe(true);
    expect(admitFinalPlan({ workDir, record: { ...record, state: 'running' } }).admitted).toBe(
      false,
    );
    expect(admitFinalPlan({ workDir, record, expectedSourceDigest: '3'.repeat(64) }).admitted).toBe(
      false,
    );
    writeFileSync(path.join(workDir, 'plan.final.md'), '# Changed after review\n');
    expect(admitFinalPlan({ workDir, record }).admitted).toBe(false);
  });

  it('rejects needs-review even when the finished run exited zero', () => {
    const workDir = baseWorkDir('needs-review-admission');
    writeReadyArtifacts(workDir, { planVersion: 0, highRisk: false });
    const record = readRunRecords(path.join(path.dirname(workDir), 'state'))[0];
    if (record?.final === undefined) {
      throw new Error('fixture final missing');
    }
    const needsReview = { ...record, final: { ...record.final, status: 'needs-review' as const } };
    expect(admitFinalPlan({ workDir, record: needsReview }).admitted).toBe(false);
  });
});

function completeScenario(options: SmokeScenarioExecution): number {
  mkdirSync(options.workDir, { recursive: true });
  mkdirSync(path.join(path.dirname(options.workDir), 'state', 'runs'), { recursive: true });
  writeJson(path.join(options.workDir, 'readiness-assessment.initial.json'), { admitted: true });
  const highRisk = options.sentinel.risk === 'high';
  writeReadyArtifacts(options.workDir, {
    planVersion: highRisk ? 1 : 0,
    highRisk,
    sourceText: readFileSync(options.inputFile, 'utf8'),
  });
  return 0;
}

function authenticScenario(options: SmokeScenarioExecution): number {
  mkdirSync(options.workDir, { recursive: true });
  mkdirSync(path.join(path.dirname(options.workDir), 'state', 'runs'), { recursive: true });
  const highRisk = options.sentinel.risk === 'high';
  const source = readFileSync(options.inputFile, 'utf8');
  const { proof } = writeReadyArtifacts(options.workDir, {
    planVersion: highRisk ? 1 : 0,
    highRisk,
    sourceText: source,
    authentic: true,
  });
  const contract = JSON.parse(
    readFileSync(path.join(options.workDir, 'readiness-contract.json'), 'utf8'),
  ) as ReadinessContract;
  writeJson(path.join(options.workDir, 'readiness-assessment.initial.json'), {
    boundary: {
      goal: contract.boundary.goal,
      in_scope: contract.boundary.inScope,
      out_of_scope: contract.boundary.outOfScope,
      constraints: contract.boundary.constraints,
    },
    domain_assessments: contract.domainAssessments.map((domain) => ({
      domain: domain.domain,
      applicability: domain.applicability,
      risk: domain.risk,
      rationale: domain.rationale,
      evidence_refs: domain.evidenceRefs,
    })),
    material_questions: [],
  });
  const calls: LiveProviderCall[] = [];
  const add = (role: LiveProviderCall['role'], output: string, candidate: string) => {
    const prompt = `Supervised ${role} task\n${source}\n${candidate}`;
    calls.push({
      id: calls.length + 1,
      role,
      prompt,
      schema: {},
      promptSha256: sha256(prompt),
      schemaSha256: canonicalJsonSha256({}),
      model: 'fake-provider',
      reasoning: 'high',
      starts: [
        {
          pid: 4242,
          pgid: '4242',
          procStartToken: 'fake-start',
          startedAt: '2026-09-05T00:00:00.000Z',
        },
      ],
      status: 0,
      output,
      outputSha256: sha256(output),
    });
  };
  const read = (name: string) => readFileSync(path.join(options.workDir, name), 'utf8');
  add('creator', read('readiness-assessment.initial.json'), source);
  if (!highRisk) {
    add('creator', JSON.stringify({ plan_markdown: read('plan.v0.md') }), source);
  }
  for (let version = 0; version <= proof.planVersion; version += 1) {
    add('critic', read(`critique.v${version}.json`), read(`plan.v${version}.md`));
    if (version < proof.planVersion) {
      add('creator', read(`update.v${version}.json`), read(`plan.v${version}.md`));
    }
  }
  if (highRisk) {
    add('judge', read(`judge.v${proof.planVersion}.json`), read(`plan.v${proof.planVersion}.md`));
    add('judge', read('judge.final.json'), read('plan.final.md'));
  }
  const providerConfig = loadPlanningSmoke().manifest.providerConfig;
  const provenance: LiveProviderProvenance = {
    version: 1,
    scenario: {
      id: options.sentinel.id,
      inputMode: options.sentinel.inputMode,
      quality: options.sentinel.quality,
      maxIterations: options.sentinel.maxIterations,
      inputSha256: sha256(source),
      workDir: options.workDir,
      repositoryRoot: options.repositoryRoot,
      controllerDigest: 'c'.repeat(64),
      profileDigest: 'd'.repeat(64),
      providerConfigSha256: fileSha256(path.join(BENCHMARK_ROOT, providerConfig)),
      workspaceRevision: options.workspaceRevision,
      attemptIdentity: options.attemptIdentity,
    },
    calls,
    completedAt: '2026-09-05T00:01:00.000Z',
    exitCode: 0,
  };
  writeFileSync(liveProvenancePath(options.workDir), JSON.stringify(provenance), { mode: 0o600 });
  return 0;
}

function smokeDependencies(
  executeScenario: PlanningSmokeDependencies['executeScenario'],
): PlanningSmokeDependencies {
  let now = 1000;
  return {
    executeScenario,
    verifyWorkspace: () => 'a'.repeat(40),
    now: () => {
      now += 1;
      return now;
    },
  };
}

function smokeOptions(name: string) {
  return {
    repositoryRoot: path.resolve(BENCHMARK_ROOT, '..', '..'),
    outputDir: path.join(temporaryRoot, name),
    scenarioTimeoutMs: 1000,
  };
}

describe('resumable bounded live smoke execution', () => {
  it('never replays successful current scenarios and retains their original provenance', async () => {
    const execute = vi.fn((options: SmokeScenarioExecution) =>
      Promise.resolve(completeScenario(options)),
    );
    const options = smokeOptions('resume-success');
    const dependencies = smokeDependencies(execute);
    const first = await runPlanningSmoke(options, dependencies);
    const second = await runPlanningSmoke(options, dependencies);
    expect(first.passed).toBe(true);
    expect(second).toEqual(first);
    expect(execute).toHaveBeenCalledTimes(2);
    const history = readSmokeAttempts(options.outputDir, first.suiteId);
    expect(history.attempts).toHaveLength(2);
    expect(history.attempts[0]).toMatchObject({
      attemptNumber: 1,
      candidateRevision: 'a'.repeat(40),
      exitCode: 0,
    });
  });

  it('reconciles provider completion before repeating an uncertain attempt', async () => {
    let interrupted = false;
    const execute = vi.fn(async (options: SmokeScenarioExecution) => {
      await Promise.resolve();
      completeScenario(options);
      if (!interrupted) {
        interrupted = true;
        throw new Error('lost completion response');
      }
      return 0;
    });
    const options = smokeOptions('resume-uncertain');
    const dependencies = smokeDependencies(execute);
    await expect(runPlanningSmoke(options, dependencies)).rejects.toThrow(
      'lost completion response',
    );
    const recovered = await runPlanningSmoke(options, dependencies);
    expect(recovered.passed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('reruns only a failed scenario while preserving the successful member of the mandatory pair', async () => {
    let failHighRisk = true;
    const execute = vi.fn(async (options: SmokeScenarioExecution) => {
      await Promise.resolve();
      completeScenario(options);
      if (options.sentinel.risk === 'high' && failHighRisk) {
        failHighRisk = false;
        return 1;
      }
      return 0;
    });
    const options = smokeOptions('resume-failure');
    const dependencies = smokeDependencies(execute);
    expect((await runPlanningSmoke(options, dependencies)).passed).toBe(false);
    expect((await runPlanningSmoke(options, dependencies)).passed).toBe(true);
    expect(execute.mock.calls.map(([scenario]) => scenario.sentinel.risk)).toEqual([
      'standard',
      'high',
      'high',
    ]);
  });

  it('invalidates mutated successful artifacts without replaying the unaffected scenario', async () => {
    const execute = vi.fn((options: SmokeScenarioExecution) =>
      Promise.resolve(completeScenario(options)),
    );
    const options = smokeOptions('mutated-success');
    const dependencies = smokeDependencies(execute);
    const first = await runPlanningSmoke(options, dependencies);
    const finalPlan = first.tasks[0]?.finalPlan;
    if (finalPlan === undefined) {
      throw new Error('fixture final plan missing');
    }
    writeFileSync(path.join(options.outputDir, finalPlan), '# Modified after success\n');
    expect((await runPlanningSmoke(options, dependencies)).passed).toBe(true);
    expect(execute.mock.calls.map(([scenario]) => scenario.sentinel.risk)).toEqual([
      'standard',
      'high',
      'standard',
    ]);
  });

  it('does not silently reseal changed original proof bytes even when they still parse as ready', async () => {
    const execute = vi.fn((scenario: SmokeScenarioExecution) =>
      Promise.resolve(completeScenario(scenario)),
    );
    const options = smokeOptions('changed-proof-bytes');
    const dependencies = smokeDependencies(execute);
    const first = await runPlanningSmoke(options, dependencies);
    const finalPlan = first.tasks[0]?.finalPlan;
    if (finalPlan === undefined) {
      throw new Error('fixture final missing');
    }
    const proofFile = path.join(
      path.dirname(path.join(options.outputDir, finalPlan)),
      'convergence.final.json',
    );
    writeFileSync(proofFile, `${readFileSync(proofFile, 'utf8')}\n`);
    expect((await runPlanningSmoke(options, dependencies)).passed).toBe(true);
    expect(execute.mock.calls.map(([scenario]) => scenario.sentinel.risk)).toEqual([
      'standard',
      'high',
      'standard',
    ]);
  });

  it('invalidates both source-dependent scenarios when the implementation pin changes and keeps cumulative attempts', async () => {
    const manifestRoot = path.join(temporaryRoot, 'manifest');
    cpSync(BENCHMARK_ROOT, manifestRoot, { recursive: true });
    const manifestFile = path.join(manifestRoot, 'smoke-manifest.json');
    const execute = vi.fn((options: SmokeScenarioExecution) =>
      Promise.resolve(completeScenario(options)),
    );
    const options = { ...smokeOptions('changed-source'), manifestFile };
    const dependencies = smokeDependencies(execute);
    await runPlanningSmoke(options, dependencies);
    const manifest = loadPlanningSmoke(manifestFile).manifest;
    writeJson(manifestFile, { ...manifest, workspaceRevision: 'b'.repeat(40) });
    expect((await runPlanningSmoke(options, dependencies)).passed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(4);
    writeJson(manifestFile, { ...manifest, workspaceRevision: 'c'.repeat(40) });
    await expect(runPlanningSmoke(options, dependencies)).rejects.toThrow(
      'attempt limit exhausted',
    );
    expect(execute).toHaveBeenCalledTimes(4);
  });

  it('reserves the entire missing mandatory scenario allowance before a provider starts', async () => {
    const execute = vi.fn((options: SmokeScenarioExecution) =>
      Promise.resolve(completeScenario(options)),
    );
    const options = { ...smokeOptions('insufficient-budget'), remainingActiveMs: () => 1999 };
    await expect(runPlanningSmoke(options, smokeDependencies(execute))).rejects.toThrow(
      'cannot fit the required',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('reserves decoder admission time before starting any scenario when an adapter context is configured', async () => {
    const execute = vi.fn((scenario: SmokeScenarioExecution) =>
      Promise.resolve(completeScenario(scenario)),
    );
    const options = {
      ...smokeOptions('decoder-budget'),
      remainingActiveMs: () => 2199,
      decoderContext: {
        registryRoot: path.join(temporaryRoot, 'registry'),
        producerRevision: 'a'.repeat(40),
        policyDigest: 'b'.repeat(64),
        timeoutMs: 100,
      },
      decoderExecution: {},
    };
    await expect(runPlanningSmoke(options, smokeDependencies(execute))).rejects.toThrow(
      'remaining active budget',
    );
    expect(execute).not.toHaveBeenCalled();
  });

  it('counts an interrupted start and enforces a finite selected attempt limit across restarts', async () => {
    const execute = vi.fn(() => Promise.reject(new Error('provider interrupted')));
    const options = { ...smokeOptions('bounded-attempts'), attemptLimit: 1 };
    const dependencies = smokeDependencies(execute);
    await expect(runPlanningSmoke(options, dependencies)).rejects.toThrow('provider interrupted');
    await expect(runPlanningSmoke(options, dependencies)).rejects.toThrow(
      'attempt limit exhausted',
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('rejects overlapping ownership and releases ownership after the first invocation ends', async () => {
    let release: (() => void) | undefined;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const execute = vi.fn(async (options: SmokeScenarioExecution) => {
      entered?.();
      await barrier;
      return completeScenario(options);
    });
    const options = smokeOptions('overlap');
    const dependencies = smokeDependencies(execute);
    const active = runPlanningSmoke(options, dependencies);
    await started;
    await expect(runPlanningSmoke(options, dependencies)).rejects.toThrow(
      'owned by a live process',
    );
    release?.();
    expect((await active).passed).toBe(true);
    expect((await runPlanningSmoke(options, dependencies)).passed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('cancels before spawning and passes only explicitly authorized provider control', async () => {
    const execute = vi.fn((options: SmokeScenarioExecution) =>
      Promise.resolve(completeScenario(options)),
    );
    const controller = new AbortController();
    controller.abort();
    const options = { ...smokeOptions('cancelled'), signal: controller.signal };
    await expect(runPlanningSmoke(options, smokeDependencies(execute))).rejects.toThrow(
      'cancelled',
    );
    expect(execute).not.toHaveBeenCalled();
    const activeOptions = {
      ...smokeOptions('explicit-control'),
      executionControlFile: '/authorized/control.json',
    };
    await runPlanningSmoke(activeOptions, smokeDependencies(execute));
    expect(execute.mock.calls[0]?.[0].environment.AGENT_QUORUM_EXECUTION_CONTROL_FILE).toBe(
      '/authorized/control.json',
    );
  });
});

describe('live smoke subprocess containment', () => {
  it('terminates a TERM-ignoring owned process within its finite scenario timeout', async () => {
    const binDir = path.join(temporaryRoot, 'fake-bin');
    mkdirSync(binDir);
    const executable = path.join(binDir, 'pnpm');
    writeFileSync(executable, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n");
    chmodSync(executable, 0o755);
    let pid: number | undefined;
    const started = performance.now();
    const exitCode = await executeSmokeScenario({
      workspaceRevision: 'a'.repeat(40),
      attemptIdentity: 'b'.repeat(64),
      repositoryRoot: temporaryRoot,
      sentinel: sentinel('standard-create-ready'),
      inputFile: path.join(temporaryRoot, 'input.md'),
      workDir: path.join(temporaryRoot, 'run'),
      environment: { ...process.env, PATH: `${binDir}:${process.env.PATH ?? ''}` },
      timeoutMs: 100,
      onSpawn: (spawned) => {
        pid = spawned;
      },
    });
    expect(exitCode).toBe(143);
    expect(performance.now() - started).toBeLessThan(2000);
    expect(pid).toBeDefined();
    if (pid !== undefined) {
      expect(isAlive(pid)).toBe(false);
    }
  });
});

describe('smoke provenance and ownership rejection', () => {
  it('rejects weaker or enlarged sentinel iteration settings', () => {
    const loaded = loadPlanningSmoke();
    for (const maxIterations of [1, 4]) {
      const changed = {
        ...loaded.manifest,
        sentinels: loaded.manifest.sentinels.map((scenario) =>
          scenario.risk === 'standard' ? { ...scenario, maxIterations } : scenario,
        ),
      };
      expect(() => {
        validatePlanningSmoke(changed, loaded.root);
      }).toThrow();
    }
  });

  it('refuses to admit a candidate that changes during execution', async () => {
    const execute = vi.fn((options: SmokeScenarioExecution) =>
      Promise.resolve(completeScenario(options)),
    );
    let verifications = 0;
    const dependencies = {
      ...smokeDependencies(execute),
      verifyWorkspace: () => {
        verifications += 1;
        return (verifications === 1 ? 'a' : 'b').repeat(40);
      },
    };
    await expect(runPlanningSmoke(smokeOptions('source-race'), dependencies)).rejects.toThrow(
      'candidate changed',
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('recovers a provably dead owner and refuses incompatible retained attempt state', async () => {
    const execute = vi.fn((options: SmokeScenarioExecution) =>
      Promise.resolve(completeScenario(options)),
    );
    const options = smokeOptions('dead-owner');
    mkdirSync(options.outputDir);
    writeJson(path.join(options.outputDir, '.smoke-owner.json'), {
      pid: 2147483647,
      processStartToken: 'dead',
      token: 'abandoned-owner',
    });
    const dependencies = smokeDependencies(execute);
    expect((await runPlanningSmoke(options, dependencies)).passed).toBe(true);
    const file = path.join(options.outputDir, 'smoke-attempts.json');
    const state = readSmokeAttempts(options.outputDir, loadPlanningSmoke().manifest.suiteId);
    writeJson(file, { ...state, schemaVersion: 99 });
    await expect(runPlanningSmoke(options, dependencies)).rejects.toThrow(
      'corrupt or incompatible',
    );
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

describe('delivery live execution receipt admission', () => {
  it('rejects zero supervised calls, changed sentinel identities and unsigned response bytes', async () => {
    const options = smokeOptions('provider-provenance-invalid');
    await runPlanningSmoke(
      options,
      smokeDependencies((scenario) => Promise.resolve(authenticScenario(scenario))),
    );
    const attempt = readSmokeAttempts(options.outputDir, loadPlanningSmoke().manifest.suiteId)
      .attempts[0];
    if (attempt === undefined) {
      throw new Error('fixture attempt missing');
    }
    const text = readFileSync(liveProvenancePath(attempt.workDir), 'utf8');
    const provenance = JSON.parse(text) as LiveProviderProvenance;
    expect(parseLiveProviderProvenance(text, provenance.scenario)).toEqual(provenance);
    expect(() =>
      parseLiveProviderProvenance(
        JSON.stringify({ ...provenance, calls: [] }),
        provenance.scenario,
      ),
    ).toThrow('provenance-incomplete');
    expect(() =>
      parseLiveProviderProvenance(text, { ...provenance.scenario, id: 'unrelated-sentinel' }),
    ).toThrow('scenario-mismatch');
    expect(() =>
      parseLiveProviderProvenance(
        JSON.stringify({
          ...provenance,
          calls: provenance.calls.map((call) => ({ ...call, output: '{}' })),
        }),
        provenance.scenario,
      ),
    ).toThrow('call-provenance-invalid');
    expect(() =>
      parseLiveProviderProvenance(
        JSON.stringify({
          ...provenance,
          calls: provenance.calls.map((call) => ({ ...call, starts: [] })),
        }),
        provenance.scenario,
      ),
    ).toThrow('call-provenance-invalid');
  });

  it('rejects forged ready proof even when a failed actual critic response is copied into the retained artifact', async () => {
    const options = smokeOptions('forged-critic-proof');
    await runPlanningSmoke(
      options,
      smokeDependencies((scenario) => Promise.resolve(authenticScenario(scenario))),
    );
    const attempt = readSmokeAttempts(options.outputDir, loadPlanningSmoke().manifest.suiteId)
      .attempts[0];
    if (attempt === undefined) {
      throw new Error('fixture attempt missing');
    }
    const provenance = JSON.parse(
      readFileSync(liveProvenancePath(attempt.workDir), 'utf8'),
    ) as LiveProviderProvenance;
    const original = readFileSync(path.join(attempt.workDir, 'critique.v0.json'), 'utf8');
    const failed = original.replaceAll('"disposition": "satisfied"', '"disposition": "violated"');
    expect(failed).not.toBe(original);
    writeFileSync(path.join(attempt.workDir, 'critique.v0.json'), failed);
    const changed = {
      ...provenance,
      calls: provenance.calls.map((call) =>
        call.role === 'critic' ? { ...call, output: failed, outputSha256: sha256(failed) } : call,
      ),
    };
    expect(() => {
      admitProviderArtifactBindings(attempt.workDir, changed);
    }).toThrow('critic-proof-not-derived');
    writeFileSync(path.join(attempt.workDir, 'critique.v0.json'), original);
    const unrelated = {
      ...provenance,
      calls: provenance.calls.map((call) =>
        call.role === 'critic' ? { ...call, prompt: 'Review another unrelated project' } : call,
      ),
    };
    expect(() => {
      admitProviderArtifactBindings(attempt.workDir, unrelated);
    }).toThrow('artifact-not-produced:critique');
    writeFileSync(
      path.join(attempt.workDir, 'plan.final.md'),
      '---\nstatus: clean\n---\n\n# Unreviewed implementation plan\n',
    );
    expect(() => {
      admitProviderArtifactBindings(attempt.workDir, provenance);
    }).toThrow('canonical-plan-not-reviewed');
  });

  it('does not replay a successful sentinel when the other lacks trusted provider provenance', async () => {
    const options = {
      ...smokeOptions('provider-recovery'),
      providerProvenance: { controllerDigest: 'c'.repeat(64), profileDigest: 'd'.repeat(64) },
    };
    let completed = 0;
    const execute = vi.fn((scenario: SmokeScenarioExecution) => {
      completed += 1;
      return Promise.resolve(
        completed === 2 ? completeScenario(scenario) : authenticScenario(scenario),
      );
    });
    const dependencies = smokeDependencies(execute);
    const first = await runPlanningSmoke(options, dependencies);
    expect(first.passed).toBe(false);
    expect(first.tasks[1]?.failures).toContain('live-provider-provenance-missing');
    expect((await runPlanningSmoke(options, dependencies)).passed).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls.map(([scenario]) => scenario.sentinel.id)).toEqual([
      'standard-create-ready',
      'high-revise-judge-ready',
      'high-revise-judge-ready',
    ]);
  });

  it('permits reviewed response projection while preserving the immutable actual call set and source metadata', () => {
    const receipt = {
      version: 1,
      scenario: { id: 'fixed-sentinel' },
      calls: [
        {
          id: 1,
          role: 'critic',
          output: '{"future":true}',
          outputSha256: sha256('{"future":true}'),
          prompt: 'exact original task',
        },
      ],
    };
    const projected = {
      ...receipt,
      calls: receipt.calls.map((call) => ({ ...call, output: '{"canonical":true}' })),
    };
    expect(() => {
      assertProviderProjection(JSON.stringify(receipt), JSON.stringify(projected));
    }).not.toThrow();
    expect(() => {
      assertProviderProjection(
        JSON.stringify(receipt),
        JSON.stringify({ ...projected, calls: [] }),
      );
    }).toThrow('projection-call-set-changed');
    expect(() => {
      assertProviderProjection(
        JSON.stringify(receipt),
        JSON.stringify({
          ...projected,
          calls: projected.calls.map((call) => ({ ...call, role: 'judge' })),
        }),
      );
    }).toThrow('projection-trusted-metadata-changed');
    expect(() => {
      assertProviderProjection(JSON.stringify(receipt), undefined);
    }).toThrow('projection-call-set-changed');
  });

  it('revalidates raw current plan evidence behind hashed two-sentinel completion receipts', async () => {
    const options = smokeOptions('delivery-receipt');
    const dependencies = smokeDependencies((scenario) =>
      Promise.resolve(authenticScenario(scenario)),
    );
    const results = await runPlanningSmoke(options, dependencies);
    const stdout = JSON.stringify({
      schemaVersion: 1,
      passed: true,
      workspaceRevision: results.workspaceRevision,
      receiptSha256: fileSha256(path.join(options.outputDir, 'smoke-results.json')),
      attemptsSha256: fileSha256(path.join(options.outputDir, 'smoke-attempts.json')),
      scenarios: results.tasks.map((task) => ({ id: task.taskId, passed: task.passed })),
    });
    const admitted = await validateLiveExecutionSummary(
      stdout,
      options.outputDir,
      results.workspaceRevision,
    );
    expect(admitted.passedScenarios).toEqual(['standard-create-ready', 'high-revise-judge-ready']);
    const finalPlan = results.tasks[0]?.finalPlan;
    if (finalPlan === undefined) {
      throw new Error('fixture plan missing');
    }
    const proofFile = path.join(
      path.dirname(path.join(options.outputDir, finalPlan)),
      'convergence.final.json',
    );
    const originalProof = readFileSync(proofFile, 'utf8');
    writeFileSync(proofFile, `${originalProof}\n`);
    await expect(
      validateLiveExecutionSummary(stdout, options.outputDir, results.workspaceRevision),
    ).rejects.toThrow('stale-live-artifact-bundle');
    writeFileSync(proofFile, originalProof);
    writeFileSync(path.join(options.outputDir, finalPlan), '# Changed raw evidence\n');
    await expect(
      validateLiveExecutionSummary(stdout, options.outputDir, results.workspaceRevision),
    ).rejects.toThrow('stale-live-plan-artifact');
  });
});

function adaptedArtifacts(
  workDir: string,
  highRisk = false,
  planVersion = highRisk ? 1 : 0,
): { input: string; inputFile: string } {
  mkdirSync(workDir, { recursive: true });
  mkdirSync(path.join(path.dirname(workDir), 'state/runs'), { recursive: true });
  writeJson(path.join(workDir, 'readiness-assessment.initial.json'), { admitted: true });
  writeReadyArtifacts(workDir, { highRisk, planVersion });
  for (let version = 0; version <= planVersion; version += 1) {
    const file = path.join(workDir, `convergence.v${version}.json`);
    writeJson(file, { ...(JSON.parse(readFileSync(file, 'utf8')) as object), schemaVersion: 4 });
  }
  const proofFile = path.join(workDir, 'convergence.final.json');
  writeJson(proofFile, {
    ...(JSON.parse(readFileSync(proofFile, 'utf8')) as object),
    schemaVersion: 4,
  });
  const inputFile = path.join(workDir, 'input.md');
  return {
    input: collectPlanningArtifacts(workDir, path.join(path.dirname(workDir), 'state'), inputFile),
    inputFile,
  };
}

function adaptingExecutor(): EvidenceDecoderExecutor {
  return {
    run: (request) => {
      const invocation = JSON.parse(request.input ?? '') as {
        input: string;
        candidate: string;
        artifactDigest: string;
      };
      if (invocation.input.startsWith('negative-')) {
        return Promise.resolve({ exitCode: 0, stdout: '{"admitted":false}', stderr: '' });
      }
      const source = parsePlanningArtifactBundle(invocation.input);
      const recordText = Object.entries(source.files).find(([name]) =>
        name.startsWith('state/runs/'),
      )?.[1];
      const record = JSON.parse(recordText ?? '') as { inputPath: string; workDir: string };
      const files = Object.fromEntries(
        Object.entries(source.files).map(([name, text]) => {
          if (!name.endsWith('.json')) {
            return [name, text];
          }
          if (name === 'provider-provenance.json') {
            const receipt = JSON.parse(text) as LiveProviderProvenance;
            return [
              name,
              JSON.stringify({
                ...receipt,
                calls: receipt.calls.map((call) => {
                  if (call.output === undefined) {
                    return call;
                  }
                  const output = JSON.parse(call.output) as { futurePayload?: unknown };
                  return output.futurePayload === undefined
                    ? call
                    : { ...call, output: JSON.stringify(output.futurePayload) };
                }),
              }),
            ];
          }
          if (name.startsWith('run/critique.')) {
            const output = JSON.parse(text) as { futurePayload?: unknown };
            if (output.futurePayload !== undefined) {
              return [name, JSON.stringify(output.futurePayload)];
            }
          }
          const normalized = text
            .replaceAll(record.inputPath, '@INPUT_PATH@')
            .replaceAll(record.workDir, '@WORK_DIR@');
          if (name.startsWith('run/convergence.')) {
            return [
              name,
              JSON.stringify({ ...(JSON.parse(normalized) as object), schemaVersion: 3 }),
            ];
          }
          return [name, normalized];
        }),
      );
      return Promise.resolve({
        exitCode: 0,
        stderr: '',
        stdout: JSON.stringify({
          admitted: true,
          evidence: {
            version: 1,
            candidate: invocation.candidate,
            artifactDigest: invocation.artifactDigest,
            schemaVersions: [4, 2, 1],
            ready: true,
            exactBindings: true,
            requiredSourcesPresent: true,
            aggregateConsistent: true,
            judgeSatisfied: true,
          },
          projection: { files },
        }),
      });
    },
  };
}

describe('reviewed schema adapters preserve frozen planning admission', () => {
  it('decodes changed provider response schemas while preserving actual supervised source bindings', async () => {
    const selected = sentinel('standard-create-ready');
    const workDir = baseWorkDir('provider-adapter');
    const inputFile = path.join(path.dirname(workDir), 'input.md');
    writeFileSync(inputFile, readFileSync(path.join(BENCHMARK_ROOT, selected.input)));
    authenticScenario({
      repositoryRoot: temporaryRoot,
      sentinel: selected,
      inputFile,
      workDir,
      environment: {},
      timeoutMs: 1000,
      workspaceRevision: 'a'.repeat(40),
      attemptIdentity: 'b'.repeat(64),
      onSpawn: () => undefined,
    });
    const originalReceipt = JSON.parse(
      readFileSync(liveProvenancePath(workDir), 'utf8'),
    ) as LiveProviderProvenance;
    const changed = {
      ...originalReceipt,
      calls: originalReceipt.calls.map((call) => {
        if (call.role !== 'critic' || call.output === undefined) {
          return call;
        }
        const output = JSON.stringify({ futurePayload: JSON.parse(call.output) as unknown });
        return {
          ...call,
          output,
          outputSha256: sha256(output),
          contract: {
            source: 'candidate' as const,
            skillFile: 'skills/plan-critic/SKILL.md',
            skillSha256: 'c'.repeat(64),
            schemaFile: 'skills/plan-critic/critique.schema.json',
            sourceSchemaSha256: 'd'.repeat(64),
          },
        };
      }),
    };
    writeFileSync(liveProvenancePath(workDir), JSON.stringify(changed));
    const critiqueFile = path.join(workDir, 'critique.v0.json');
    writeJson(critiqueFile, {
      futurePayload: JSON.parse(readFileSync(critiqueFile, 'utf8')) as unknown,
    });
    const input = collectPlanningArtifacts(
      workDir,
      path.join(path.dirname(workDir), 'state'),
      inputFile,
    );
    const decoderFile = path.join(temporaryRoot, 'provider-decoder.mjs');
    writeFileSync(decoderFile, 'exact independently reviewed provider schema adapter fixture');
    const fixtures = [
      { name: 'valid', input },
      ...DECODER_NEGATIVE_CASES.map((name) => ({ name, input: `negative-${name}` })),
    ];
    const proposal = {
      decoderFile,
      decoderDigest: fileSha256(decoderFile),
      fixtures,
      fixtureSetDigest: evidenceDecoderFixtureDigest(fixtures),
    };
    const context = {
      registryRoot: path.join(temporaryRoot, 'provider-adapter-registry'),
      producerRevision: 'a'.repeat(40),
      policyDigest: 'c'.repeat(64),
      timeoutMs: 10_000,
    };
    const criteria = evidenceDecoderAcceptance(
      proposal.decoderDigest,
      proposal.fixtureSetDigest,
      context.policyDigest,
    );
    const review: ReviewReceipt = {
      candidate: 'd'.repeat(64),
      invocationId: 'independent-provider-decoder-review',
      implementationInvocationId: 'provider-decoder-implementation',
      acceptanceDigest: digest(criteria),
      approved: true,
      findings: [],
      acceptanceEvidence: criteria.map((criterion) => ({
        ...criterion,
        evidence: [
          'Exact provider input/output mapping and negative verdict preservation reviewed',
        ],
      })),
      adjacentFindings: [],
      liveReuseApproved: false,
      interveningDiffDigest: '',
    };
    const executor = adaptingExecutor();
    await expect(
      evaluateSmokeWithDecoder({
        sentinel: selected,
        outputDir: temporaryRoot,
        workDir,
        inputFile,
        exitCode: 0,
        options: {},
      }),
    ).rejects.toThrow('requires an approved decoder');
    await adoptReviewedEvidenceDecoder(
      {
        ...context,
        reviewCandidate: review.candidate,
        proposal,
        independentReview: review,
        execution: {},
      },
      executor,
    );
    const result = await evaluateSmokeWithDecoder({
      sentinel: selected,
      outputDir: temporaryRoot,
      workDir,
      inputFile,
      exitCode: 0,
      options: { decoderContext: context, decoderExecution: {} },
      decoderExecutor: executor,
    });
    expect(result.passed).toBe(true);
    expect(readFileSync(liveProvenancePath(workDir), 'utf8')).toBe(JSON.stringify(changed));
  });

  it('freezes exact independently reviewed bytes, executes conformance and retains all sentinel assertions for newer artifacts', async () => {
    const workDir = path.join(temporaryRoot, 'future/run');
    const future = adaptedArtifacts(workDir);
    expect(planningArtifactsNeedDecoder(future.input)).toBe(true);
    await expect(
      admitDeliveryPlanArtifacts(
        workDir,
        path.join(path.dirname(workDir), 'state'),
        future.inputFile,
        fileSha256(future.inputFile),
        {},
      ),
    ).rejects.toThrow('evidence-decoder-not-approved');
    const decoderFile = path.join(temporaryRoot, 'decoder.mjs');
    writeFileSync(decoderFile, 'self-contained reviewed decoder fixture');
    const fixtures = [
      { name: 'valid', input: future.input },
      ...DECODER_NEGATIVE_CASES.map((name) => ({ name, input: `negative-${name}` })),
    ];
    const proposal = {
      decoderFile,
      decoderDigest: fileSha256(decoderFile),
      fixtures,
      fixtureSetDigest: evidenceDecoderFixtureDigest(fixtures),
    };
    const context = {
      registryRoot: path.join(temporaryRoot, 'approved'),
      producerRevision: 'a'.repeat(40),
      policyDigest: 'b'.repeat(64),
      timeoutMs: 10_000,
    };
    const acceptance = evidenceDecoderAcceptance(
      proposal.decoderDigest,
      proposal.fixtureSetDigest,
      context.policyDigest,
    );
    const independentReview: ReviewReceipt = {
      candidate: 'c'.repeat(64),
      invocationId: 'independent-adapter-review',
      implementationInvocationId: 'adapter-implementation',
      acceptanceDigest: digest(acceptance),
      approved: true,
      findings: [],
      acceptanceEvidence: acceptance.map((criterion) => ({
        ...criterion,
        evidence: ['Exact implementation and negative fixture semantics reviewed'],
      })),
      adjacentFindings: [],
      liveReuseApproved: false,
      interveningDiffDigest: '',
    };
    const options = {
      ...context,
      reviewCandidate: independentReview.candidate,
      proposal,
      independentReview,
      execution: {},
    };
    const executor = adaptingExecutor();
    await adoptReviewedEvidenceDecoder(options, executor);
    expect(readApprovedEvidenceDecoder(context)?.decoderDigest).toBe(proposal.decoderDigest);
    await expect(
      adoptReviewedEvidenceDecoder({ ...options, reviewCandidate: 'd'.repeat(64) }, executor),
    ).rejects.toThrow('decoder-admission-already-frozen');
    const standard = loadPlanningSmoke().manifest.sentinels.find(
      (sentinel) => sentinel.risk === 'standard',
    );
    if (standard === undefined) {
      throw new Error('standard fixture missing');
    }
    const evaluated = await evaluateSmokeWithDecoder({
      sentinel: standard,
      outputDir: temporaryRoot,
      workDir,
      inputFile: future.inputFile,
      exitCode: 0,
      options: { decoderContext: context, decoderExecution: {} },
      decoderExecutor: executor,
    });
    expect(evaluated.passed).toBe(true);
    expect(evaluated.finalPlanSha256).toBe(fileSha256(path.join(workDir, 'plan.final.md')));
    await expect(
      evaluateSmokeWithDecoder({
        sentinel: standard,
        outputDir: temporaryRoot,
        workDir,
        inputFile: future.inputFile,
        exitCode: 0,
        options: {
          decoderContext: { ...context, producerRevision: 'e'.repeat(40) },
          decoderExecution: {},
        },
        decoderExecutor: executor,
      }),
    ).rejects.toThrow('evidence-decoder-not-approved');
    const highWorkDir = path.join(temporaryRoot, 'insufficient-high/run');
    const high = adaptedArtifacts(highWorkDir, true, 0);
    const highSentinel = loadPlanningSmoke().manifest.sentinels.find(
      (sentinel) => sentinel.risk === 'high',
    );
    if (highSentinel === undefined) {
      throw new Error('high fixture missing');
    }
    await expect(
      evaluateSmokeWithDecoder({
        sentinel: highSentinel,
        outputDir: temporaryRoot,
        workDir: highWorkDir,
        inputFile: high.inputFile,
        exitCode: 0,
        options: { decoderContext: context, decoderExecution: {} },
        decoderExecutor: executor,
      }),
    ).rejects.toThrow('failed frozen sentinel assertions');
    writeFileSync(
      path.join(workDir, 'plan.final.md'),
      '---\nstatus: clean\n---\nChanged after review',
    );
    await expect(
      evaluateSmokeWithDecoder({
        sentinel: standard,
        outputDir: temporaryRoot,
        workDir,
        inputFile: future.inputFile,
        exitCode: 0,
        options: { decoderContext: context, decoderExecution: {} },
        decoderExecutor: executor,
      }),
    ).rejects.toThrow('decoder-projection-readiness-rejected');
  });

  it('forbids adapters from substituting original markdown or writing outside the normalized artifact projection', () => {
    const workDir = path.join(temporaryRoot, 'substitution/run');
    const future = adaptedArtifacts(workDir);
    const source = parsePlanningArtifactBundle(future.input);
    expect(() => {
      withPlanningArtifactProjection(
        future.input,
        { files: { ...source.files, 'run/plan.final.md': 'Replacement plan' } },
        path.join(temporaryRoot, 'scratch'),
        () => undefined,
      );
    }).toThrow('decoder-changed-original-plan-or-input');
    expect(() =>
      parsePlanningArtifactProjection({ files: { '../../outside.json': '{}' } }),
    ).toThrow('invalid-decoder-artifact-projection');
  });
});

function designFixture(): { mandate: Mandate; issue: DeliveryIssue; workDir: string } {
  const repository = path.join(temporaryRoot, 'candidate');
  const runtimeRoot = path.join(temporaryRoot, 'frozen');
  mkdirSync(repository);
  mkdirSync(runtimeRoot);
  const configFile = path.join(temporaryRoot, 'planning.json');
  writeJson(configFile, {});
  const mandate: Mandate = {
    version: 1,
    repository: 'eventbalancer/agent-quorum',
    base: 'main',
    sourceRoot: repository,
    runtimeRoot,
    controllerDigest: 'a'.repeat(64),
    profileDigest: 'b'.repeat(64),
    policyVersion: 1,
    profile: {
      worker: { model: 'fixture', reasoning: 'high' },
      reviewer: { model: 'fixture', reasoning: 'high' },
      planning: { configFile, quality: 'quick', maxIterations: 3, maxRuns: 2 },
      bounds: {
        providerStartsPerIssue: 20,
        providerStartsPerDay: 60,
        providerTimeoutMs: 10000,
        providerRetries: 0,
        providerRetryDelayMs: 1,
        commandTimeoutMs: 10000,
        liveStartsPerScenario: 2,
        liveScenarioTimeoutMs: 1000,
      },
      scope: { include: [], exclude: [], priorities: [] },
    },
    requiredChecks: [{ context: 'ci', appId: 1 }],
    actor: 'fixture',
    mcpServerNames: [],
    mcpConfigurationDigest: 'c'.repeat(64),
    workflowTreeSha: 'd'.repeat(40),
    issueLimitMs: ISSUE_LIMIT_MS,
    dailyLimitMs: DAY_LIMIT_MS,
    repairLimit: REPAIR_LIMIT,
    timezone: 'Europe/Moscow',
    operations: DELIVERY_OPERATIONS,
    releases: false,
    createdAt: '2026-09-05T00:00:00Z',
  };
  const issue: DeliveryIssue = {
    number: 1,
    nodeId: 'issue1',
    title: 'Plan current change',
    originalBody: 'Preserve current issue outcome',
    fingerprint: 'fingerprint',
    stage: 'plan',
    baseSha: 'e'.repeat(40),
    acceptance: [{ id: 'AC1', outcome: 'Deliver requested change', evidence: [] }],
    decisions: [],
    dependencies: [],
    findingKeys: [],
    worktree: repository,
  };
  return { mandate, issue, workDir: path.join(temporaryRoot, 'state/design/1-1') };
}

describe('durable design planning admission', () => {
  it('readmits an exact successful design after a lost response without replaying a provider or mutating frozen runtime', async () => {
    const { mandate, issue: originalIssue, workDir } = designFixture();
    const issue = {
      ...originalIssue,
      currentBody: 'Current amended problem and acceptance',
      originalTitle: 'Original evidence title',
    };
    const run = vi.fn(async () => {
      await Promise.resolve();
      mkdirSync(workDir, { recursive: true });
      mkdirSync(path.join(path.dirname(workDir), 'state/runs'), { recursive: true });
      const inputPath = `${workDir}.prompt.md`;
      const sourceText = readFileSync(inputPath, 'utf8');
      const systemDigest = buildSystemContext({
        projectRoot: issue.worktree ?? '',
        mode: 'prompt',
        inputFile: inputPath,
      }).digest;
      writeReadyArtifacts(workDir, { planVersion: 0, highRisk: false, sourceText, systemDigest });
      cpSync(path.join(path.dirname(workDir), 'state'), `${workDir}.home/state`, {
        recursive: true,
      });
      return { exitCode: 0 };
    });
    const first = await runDeliveryPlan(mandate, issue, workDir, {}, undefined, run);
    expect(await runDeliveryPlan(mandate, issue, workDir, {}, undefined, run)).toEqual(first);
    expect(run).toHaveBeenCalledOnce();
    expect(existsSync(path.join(mandate.runtimeRoot, 'planning-home'))).toBe(false);
    const prompt = readFileSync(`${workDir}.prompt.md`, 'utf8');
    expect(prompt).toContain('## Current problem\n\nCurrent amended problem and acceptance');
    expect(prompt).toContain(
      `## Original issue evidence\n\nOriginal title: Original evidence title\n\n${issue.originalBody}`,
    );
    await expect(
      runDeliveryPlan(
        mandate,
        { ...issue, currentBody: 'Another amendment' },
        workDir,
        {},
        undefined,
        run,
      ),
    ).rejects.toThrow('design-plan-input-changed');
    await expect(
      runDeliveryPlan(
        mandate,
        { ...issue, originalBody: 'Changed problem' },
        workDir,
        {},
        undefined,
        run,
      ),
    ).rejects.toThrow('design-plan-input-changed');
    writeJson(mandate.profile.planning.configFile, { telegram: { clarify: 'off' } });
    await expect(runDeliveryPlan(mandate, issue, workDir, {}, undefined, run)).rejects.toThrow(
      'design-attempt-inputs-changed',
    );
    expect(run).toHaveBeenCalledOnce();
  });

  it('preserves incomplete attempt artifacts and requires an explicitly bounded new work directory', async () => {
    const { mandate, issue, workDir } = designFixture();
    const run = vi.fn(async () => {
      await Promise.resolve();
      mkdirSync(workDir, { recursive: true });
      writeFileSync(path.join(workDir, 'plan.v0.md'), '# Unfinished plan');
      return { exitCode: 1 };
    });
    await expect(runDeliveryPlan(mandate, issue, workDir, {}, undefined, run)).rejects.toThrow(
      'design-planning-failed',
    );
    await expect(runDeliveryPlan(mandate, issue, workDir, {}, undefined, run)).rejects.toThrow(
      'design-plan-not-ready',
    );
    expect(run).toHaveBeenCalledOnce();
    expect(readFileSync(path.join(workDir, 'plan.v0.md'), 'utf8')).toBe('# Unfinished plan');
  });
});
