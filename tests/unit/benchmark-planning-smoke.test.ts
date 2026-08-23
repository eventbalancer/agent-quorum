import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ajvModule from 'ajv/dist/2020.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BENCHMARK_ROOT } from '../../scripts/benchmark-planning/benchmark.js';
import type {
  PlanningSmokeResults,
  PlanningSmokeSentinel,
} from '../../scripts/benchmark-planning/model.js';
import {
  evaluatePlanningSmokeSentinel,
  loadPlanningSmoke,
} from '../../scripts/benchmark-planning/smoke.js';
import { qualityMatrix } from '../../src/core/quality.js';
import {
  RISK_DOMAINS,
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
const SOURCE_DIGEST = '1'.repeat(64);
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

function frozenContract(quality: Quality, highRisk: boolean): ReadinessContract {
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
    sourceDigest: SOURCE_DIGEST,
    systemDigest: SYSTEM_DIGEST,
    quality,
    iterationLimit: 3,
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
    sourceDigest: SOURCE_DIGEST,
    authoritativeDigest: SYSTEM_DIGEST,
    relationshipIds: [],
    maxIters: 3,
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

function writeReadyArtifacts(
  workDir: string,
  options: {
    readonly planVersion: number;
    readonly highRisk: boolean;
    readonly fixReviewer?: FixReviewerMode;
  },
): ReadyArtifacts {
  const quality: Quality = options.highRisk ? 'balanced' : 'quick';
  const contract = frozenContract(quality, options.highRisk);
  writeFrozenReadinessContract(path.join(workDir, 'readiness-contract.json'), contract);
  const finalPlan = '---\nstatus: clean\n---\n\n# Final smoke plan\n';
  const digest = sha256(finalPlan);
  writeFileSync(path.join(workDir, 'plan.final.md'), finalPlan);
  let finalReviewed: ReadinessProofState | undefined;
  for (let version = 0; version <= options.planVersion; version += 1) {
    const plan = version === options.planVersion ? finalPlan : `# Smoke plan v${String(version)}\n`;
    writeFileSync(path.join(workDir, `plan.v${String(version)}.md`), plan);
    const reviewed = reviewedState({
      contract,
      planVersion: version,
      planSha256: sha256(plan),
      highRisk: options.highRisk,
    });
    writeReadinessProofState(path.join(workDir, `convergence.v${String(version)}.json`), reviewed);
    writeJson(path.join(workDir, `critique.v${String(version)}.json`), {
      issues: options.highRisk && version === 0 ? [{ id: 'C1', severity: 'major' }] : [],
    });
    if (version < options.planVersion) {
      writeJson(path.join(workDir, `update.v${String(version)}.json`), { applied: ['C1'] });
      writeJson(path.join(workDir, `update-meta.v${String(version)}.json`), { applied: ['C1'] });
    }
    finalReviewed = reviewed;
  }
  if (finalReviewed === undefined) {
    throw new Error('final reviewed smoke state is unavailable');
  }
  const proof = canonicalState(
    finalReviewed,
    digest,
    options.fixReviewer ?? (options.highRisk ? 'required' : 'exempt'),
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
    writeJson(path.join(workDir, `judge.v${String(options.planVersion)}.json`), { ready: true });
    writeJson(path.join(workDir, 'judge.final.json'), { ready: true });
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
    ).toContain('complete payload directly to the final record path with writeFileSync');
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
