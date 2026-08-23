import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { nonEmptyFile } from '../../runtime/files.js';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';
import { artifactVersion } from './critic.js';
import { schemaValidQuiet } from '../../core/schema.js';
import { admitCreatorUpdate, type ExpectedCreatorIssue } from '../../core/readiness-admission.js';
import type { ResumeState, RunContext } from '../../core/run-context.js';
import {
  bindVersionedPlan,
  createOccurrenceSourceBinding,
  invalidateDeterministicProof,
  invalidateFinalizationProof,
  invalidateFullReviewProof,
  recordAuthoritativeContext,
  type OccurrenceSource,
  type OccurrenceSourceBinding,
  type ReadinessProofState,
} from '../../core/readiness-proof.js';
import { canonicalJsonSha256, fileSha256, stableTupleId } from '../../core/digest.js';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { readReadinessContract, type ReadinessContract } from '../../core/readiness-contract.js';
import {
  readReadinessProofState,
  readReadinessProofStateIfPresent,
  writeReadinessProofState,
} from '../../core/readiness-store.js';
import { validateSystemCoverage } from '../../core/system-context.js';

function sortedMatches(work: string, prefix: string, suffix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(work);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort()
    .map((name) => path.join(work, name));
}

export function lastStablePlan(ctx: RunContext): number {
  const work = ctx.work;
  let best = -1;
  let stableProof: ReadinessProofState | undefined;
  const plans = sortedMatches(work, 'plan.v', '.md').sort((left, right) => {
    return (
      (artifactVersion(left, 'plan.v', '.md') ?? Number.MAX_SAFE_INTEGER) -
      (artifactVersion(right, 'plan.v', '.md') ?? Number.MAX_SAFE_INTEGER)
    );
  });
  for (const file of plans) {
    const n = artifactVersion(file, 'plan.v', '.md');
    if (n === undefined) {
      continue;
    }
    const proofFile = path.join(work, `convergence.v${n}.json`);
    let proof: ReadinessProofState | undefined;
    try {
      proof = readReadinessProofStateIfPresent(proofFile);
    } catch {
      resumeFailure(`invalid readiness proof for plan.v${n}.md (code=proof-invalid)`);
    }
    if (proof === undefined) {
      continue;
    }
    assertCandidateProof(proof, n);
    if (n === 0) {
      best = Math.max(best, 0);
      stableProof = proof;
      continue;
    }
    if (best !== n - 1 || stableProof === undefined) {
      continue;
    }
    const update = path.join(work, `update.v${n - 1}.json`);
    if (!nonEmptyFile(update)) {
      continue;
    }
    if (!schemaValidQuiet(update, ctx.skills.creatorSchema)) {
      resumeFailure(`creator update for plan.v${n}.md failed schema validation`);
    }
    if (!updateCommitsPlanAndLedger(ctx, update, file, stableProof, proof, n)) {
      continue;
    }
    if (n > best) {
      best = n;
      stableProof = proof;
    }
  }
  if (best < 0) {
    const message = `resume failed: no stable plan.vN.md found in ${work}`;
    err(message);
    throw new HaltError(message, 4, true);
  }
  return best;
}

function resumeFailure(detail: string): never {
  const message = `resume failed: ${detail}`;
  err(message);
  throw new HaltError(message, 4, true);
}

function assertCandidateProof(state: ReadinessProofState, planVersion: number): void {
  if (state.planVersion !== planVersion || state.catalog.expectedPlanVersion !== planVersion) {
    resumeFailure(`readiness proof does not match plan.v${planVersion}.md`);
  }
  if (state.planSha256 === undefined) {
    resumeFailure(`readiness proof for plan.v${planVersion}.md is unbound`);
  }
  const findingIds = [...state.findings.map((finding) => finding.id)].sort();
  if (!sameStrings(findingIds, state.catalog.materialIssueIds)) {
    resumeFailure(`readiness proof catalog for plan.v${planVersion}.md is incomplete`);
  }
  for (const slot of state.sources) {
    if (
      slot.requirement.required &&
      (slot.requirement.expectedBinding.candidate.contentDigest.startsWith('unbound:') ||
        slot.requirement.expectedBinding.lineage.lineageDigest.startsWith('unbound:'))
    ) {
      resumeFailure(`readiness proof source ${slot.source} for plan.v${planVersion}.md is unbound`);
    }
  }
}

function readJsonValue(file: string): JsonValue | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  } catch {
    return undefined;
  }
}

function rejectedLedgerEntries(work: string): JsonValue[] {
  const file = path.join(work, 'rejected-log.jsonl');
  if (!nonEmptyFile(file)) {
    return [];
  }
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as JsonValue];
      } catch {
        return [];
      }
    });
}

function expectedCreatorIssuesForResume(
  ctx: RunContext,
  previousState: ReadinessProofState,
): ExpectedCreatorIssue[] {
  const planVersion = previousState.planVersion;
  const file = path.join(ctx.work, `critique.v${planVersion}.json`);
  if (!nonEmptyFile(file) || !schemaValidQuiet(file, ctx.skills.criticSchema)) {
    return resumeFailure(`critique for plan.v${planVersion}.md failed schema validation`);
  }
  const value = readJsonValue(file);
  if (!isJsonObject(value) || value.plan_version !== planVersion || !Array.isArray(value.issues)) {
    return resumeFailure(`critique for plan.v${planVersion}.md has invalid lineage`);
  }
  return value.issues.map((entry, index) => {
    if (
      !isJsonObject(entry) ||
      typeof entry.id !== 'string' ||
      (entry.severity !== 'blocker' && entry.severity !== 'major') ||
      typeof entry.claim !== 'string' ||
      entry.claim.trim() === '' ||
      typeof entry.evidence !== 'string' ||
      entry.evidence.trim() === '' ||
      typeof entry.suggested_fix !== 'string' ||
      entry.suggested_fix.trim() === ''
    ) {
      return resumeFailure(`critique issue ${index} for plan.v${planVersion}.md is invalid`);
    }
    const issueRef = `v${planVersion}.${entry.id}`;
    const judgeRevisionId = stableTupleId('judge-revision', [
      planVersion,
      entry.claim,
      entry.evidence,
      entry.suggested_fix,
    ]);
    const provenance = previousState.admittedCriticIssueRefs.includes(issueRef)
      ? 'critic'
      : previousState.intermediateJudgeMaterialIssueIds.includes(judgeRevisionId)
        ? 'intermediate-judge'
        : resumeFailure(`critique issue ${index} has no admitted role provenance`);
    return {
      id: entry.id,
      severity: entry.severity,
      claim: entry.claim,
      evidence: entry.evidence,
      suggestedFix: entry.suggested_fix,
      provenance,
    };
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function updateCommitsPlanAndLedger(
  ctx: RunContext,
  updateFile: string,
  planFile: string,
  previousState: ReadinessProofState,
  state: ReadinessProofState,
  planVersion: number,
): boolean {
  const work = ctx.work;
  const value = readJsonValue(updateFile);
  if (!isJsonObject(value) || value.plan_version !== planVersion) {
    return false;
  }
  if (value.plan_markdown !== readFileSync(planFile, 'utf8')) {
    return false;
  }
  const rejected = Array.isArray(value.rejected_append) ? value.rejected_append : [];
  const ledger = rejectedLedgerEntries(work);
  const availableLedgerEntries = ledger.filter(isJsonObject);
  for (const expected of rejected) {
    if (!isJsonObject(expected)) {
      return false;
    }
    const committedIndex = availableLedgerEntries.findIndex(
      (entry) =>
        entry.iter === planVersion - 1 &&
        entry.id === expected.id &&
        entry.claim === expected.claim &&
        entry.reason === expected.reason,
    );
    if (committedIndex < 0) {
      return false;
    }
    availableLedgerEntries.splice(committedIndex, 1);
  }
  let admitted;
  try {
    admitted = admitCreatorUpdate({
      value,
      currentCatalog: previousState.catalog,
      fromPlanVersion: planVersion - 1,
      expectedPlanVersion: planVersion,
      expectedIssues: expectedCreatorIssuesForResume(ctx, previousState),
      retainedFindings: previousState.findings,
      retainedInvariants: previousState.invariants,
      evidenceContext: {
        work,
        projectRoot: ctx.provider.projectRoot,
        planVersion,
        candidateContent: readFileSync(planFile, 'utf8'),
        candidatePath: planFile,
      },
      operatorInterventionIds: previousState.interventionIds,
      admittedCriticIssueRefs: previousState.admittedCriticIssueRefs,
      admittedJudgeRevisionIssueIds: previousState.intermediateJudgeMaterialIssueIds,
    });
  } catch {
    return resumeFailure(`creator update for plan.v${planVersion}.md failed semantic admission`);
  }
  if (
    state.creatorTransitionReceipt === undefined ||
    !sameJson(admitted.transitionReceipt, state.creatorTransitionReceipt) ||
    !sameJson(admitted.nextCatalog, state.catalog) ||
    !sameJson(admitted.findings, state.findings) ||
    !sameJson(admitted.invariants, state.invariants) ||
    !sameJson(admitted.materialRevisionProofGapIds, state.materialRevisionProofGapIds)
  ) {
    return resumeFailure(
      `creator update for plan.v${planVersion}.md does not match its readiness proof receipt`,
    );
  }
  return true;
}

function stampForArchive(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function archiveResumeFile(work: string, state: ResumeState, file: string): void {
  if (!existsSync(file)) {
    return;
  }
  if (state.archiveDir === '') {
    state.archiveDir = path.join(work, `stale.${stampForArchive()}`);
    mkdirSync(state.archiveDir, { recursive: true });
  }
  renameSync(file, path.join(state.archiveDir, path.basename(file)));
  state.archivedCount += 1;
}

function archiveResumeSnapshot(work: string, state: ResumeState, file: string): void {
  if (!existsSync(file)) {
    return;
  }
  if (state.archiveDir === '') {
    state.archiveDir = path.join(work, `stale.${stampForArchive()}`);
    mkdirSync(state.archiveDir, { recursive: true });
  }
  const target = path.join(state.archiveDir, path.basename(file));
  if (existsSync(target)) {
    return;
  }
  copyFileSync(file, target);
  state.archivedCount += 1;
}

export function archiveResumeStale(work: string, state: ResumeState, start: number): void {
  const sweep = (prefix: string, suffix: string, keepUpTo: (n: number) => boolean) => {
    for (const file of sortedMatches(work, prefix, suffix)) {
      const n = artifactVersion(file, prefix, suffix);
      if (n === undefined) {
        continue;
      }
      if (!keepUpTo(n)) {
        archiveResumeFile(work, state, file);
      }
    }
  };
  sweep('critique.v', '.json', (n) => n < start);
  sweep('update.v', '.json', (n) => n < start);
  sweep('update-meta.v', '.json', (n) => n < start);
  sweep('plan.revision.v', '.md', (n) => n < start);
  sweep('plan.v', '.md', (n) => n <= start);
  sweep('convergence.v', '.json', (n) => n <= start);
  sweep('system-check.v', '.json', (n) => n <= start);
  sweep('judge.v', '.json', (n) => n < start);
  for (const name of readdirSync(work)) {
    if (/^plan\.final\.(?!before-fix\.md$).+\.md$/.test(name)) {
      archiveResumeFile(work, state, path.join(work, name));
    }
  }
  for (const extra of [
    'plan.final.md',
    'summary.md',
    'findings.json',
    'fix-proposal.md',
    'fix-review.json',
    'fix-applied.md',
    'fix-applied-review.json',
    'plan.final.before-fix.md',
    'plan.split.json',
    'package-findings.json',
    'plan.package',
    'judge.final.raw',
    'judge.final.json',
    'judge.final.meta.json',
    'convergence.final.json',
    'system-check.final.json',
  ]) {
    archiveResumeFile(work, state, path.join(work, extra));
  }
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }
  const sortedLeft = [...left].sort();
  const sortedRight = [...right].sort();
  return sortedLeft.every((value, index) => value === sortedRight[index]);
}

function readFrozenResumeContract(work: string): ReadinessContract {
  const file = path.join(work, 'readiness-contract.json');
  try {
    return readReadinessContract(file);
  } catch {
    resumeFailure('readiness contract is missing or invalid (code=contract-invalid)');
  }
}

function frozenContractProofSemanticsMatch(
  restored: ReadinessProofState,
  contract: ReadinessContract,
): boolean {
  const expectedQuestionIds = contract.unresolvedMaterialQuestions.map((question) => question.id);
  if (!sameStrings(restored.unresolvedMaterialQuestionIds, expectedQuestionIds)) {
    return false;
  }
  for (const assessment of contract.domainAssessments) {
    const current = restored.riskDomains.find(
      (candidate) => candidate.domain === assessment.domain,
    );
    if (current === undefined) {
      return false;
    }
    if (assessment.applicability === 'applicable' && current.applicability !== 'applicable') {
      return false;
    }
    if (assessment.risk === 'high' && current.risk !== 'high') {
      return false;
    }
  }
  return true;
}

function assertCompatibleResumeContract(
  ctx: RunContext,
  restored: ReadinessProofState,
  contract: ReadinessContract,
): void {
  const mismatches: string[] = [];
  if (
    restored.sourceDigest !== contract.sourceDigest ||
    contract.sourceDigest !== ctx.readinessProof.sourceDigest
  ) {
    mismatches.push('input source');
  }
  if (
    restored.quality !== contract.appetite.quality ||
    contract.appetite.quality !== ctx.settings.quality
  ) {
    mismatches.push('quality');
  }
  if (
    restored.scopeSource !== ctx.readinessProof.scopeSource ||
    restored.originalRequestAvailable !== ctx.readinessProof.originalRequestAvailable
  ) {
    mismatches.push('scope source');
  }
  if (
    restored.iterationLimit !== contract.appetite.iterationLimit ||
    contract.appetite.iterationLimit !== ctx.settings.maxIters
  ) {
    mismatches.push('iteration limit');
  }
  if (
    restored.issueBudget.limit !== contract.appetite.issueBudget ||
    restored.judgeAllowed !== contract.appetite.judgeAllowed ||
    restored.exhaustiveApplicableDomains !== contract.appetite.exhaustiveApplicableDomains
  ) {
    mismatches.push('assurance appetite');
  }
  if (restored.readinessContractDigest !== contract.contractDigest) {
    mismatches.push('readiness contract digest');
  }
  if (
    !sameStrings(restored.catalog.riskDomainIds, contract.proofCatalogSeed.riskDomains) ||
    !sameStrings(
      restored.catalog.retainedContextCategories,
      contract.proofCatalogSeed.retainedContextCategories,
    )
  ) {
    mismatches.push('readiness proof catalog seed');
  }
  if (
    !contract.operatorDecisionIds.every((decisionId) =>
      restored.operatorDecisionIds.includes(decisionId),
    )
  ) {
    mismatches.push('operator decisions');
  }
  if (!frozenContractProofSemanticsMatch(restored, contract)) {
    mismatches.push('frozen readiness semantics');
  }
  if (mismatches.length > 0) {
    resumeFailure(`${mismatches.join(', ')} differs from the selected run contract`);
  }
}

function reconcileJsonlLedger(
  work: string,
  state: ResumeState,
  name: string,
  keep: (entry: JsonValue) => boolean,
): void {
  const file = path.join(work, name);
  if (!nonEmptyFile(file)) {
    return;
  }
  const lines = readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '');
  const kept: string[] = [];
  for (const line of lines) {
    try {
      const value = JSON.parse(line) as JsonValue;
      if (keep(value)) {
        kept.push(line);
      }
    } catch {
      // Invalid entries are stale for deterministic resume and remain in the archived copy.
    }
  }
  if (kept.length === lines.length) {
    return;
  }
  archiveResumeSnapshot(work, state, file);
  const temporary = `${file}.resume-${process.pid}`;
  try {
    writeFileSync(temporary, kept.length === 0 ? '' : `${kept.join('\n')}\n`);
    renameSync(temporary, file);
  } finally {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* preserve the active ledger even when best-effort temp cleanup fails */
    }
  }
}

function planRefVersion(value: JsonValue | undefined): number | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const match = /^plan\.v([0-9]+)\.md$/.exec(value);
  return match === null ? undefined : Number(match[1]);
}

function requiredStringArray(value: JsonValue | undefined): string[] | undefined {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : undefined;
}

function requiresSystemCoverage(state: ReadinessProofState): boolean {
  return state.riskDomains.some(
    (domain) =>
      domain.domain === 'cross-repository-delivery' && domain.applicability === 'applicable',
  );
}

function systemCheckMatchesState(
  ctx: RunContext,
  state: ReadinessProofState,
  planFile: string,
  contract: ReadinessContract,
): boolean {
  const file = path.join(ctx.work, `system-check.v${state.planVersion}.json`);
  if (state.systemProofBinding === undefined) {
    return !existsSync(file);
  }
  const check = readJsonValue(file);
  if (!isJsonObject(check)) {
    return false;
  }
  const trustedCheck = validateSystemCoverage(ctx.systemContext, planFile, state.planVersion, {
    required: requiresSystemCoverage(state),
    inScope: contract.boundary.inScope,
    outOfScope: contract.boundary.outOfScope,
  });
  const trustedValue = JSON.parse(JSON.stringify(trustedCheck)) as JsonValue;
  const mismatches = requiredStringArray(check.mismatches);
  const unavailable = requiredStringArray(check.requiredEvidenceUnavailable);
  return (
    canonicalJsonSha256(check) === canonicalJsonSha256(trustedValue) &&
    trustedCheck.planSha256 === state.systemProofBinding.planSha256 &&
    trustedCheck.systemDigest === state.systemProofBinding.authoritativeDigest &&
    trustedCheck.passed === state.systemCheckPassed &&
    mismatches !== undefined &&
    sameStrings(mismatches, state.systemMismatchIds) &&
    unavailable !== undefined &&
    sameStrings(unavailable, state.requiredEvidenceUnavailable)
  );
}

function bindingMatches(left: OccurrenceSourceBinding, right: OccurrenceSourceBinding): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function expectedBinding(
  state: ReadinessProofState,
  source: OccurrenceSource,
  binding: OccurrenceSourceBinding,
): OccurrenceSourceBinding {
  return createOccurrenceSourceBinding(state, {
    source,
    candidateKind: binding.candidate.kind,
    contentDigest: binding.candidate.contentDigest,
  });
}

interface SourcePreflight {
  readonly versionedReviewMismatch: boolean;
  readonly finalizationProofPresent: boolean;
}

function sourcePreflight(state: ReadinessProofState): SourcePreflight {
  const critic = state.sources.find((slot) => slot.source === 'critic');
  const fixReviewer = state.sources.find((slot) => slot.source === 'fix-reviewer');
  const intermediateJudge = state.sources.find((slot) => slot.source === 'intermediate-judge');
  const finalJudge = state.sources.find((slot) => slot.source === 'final-judge');
  if (
    critic === undefined ||
    fixReviewer === undefined ||
    intermediateJudge === undefined ||
    finalJudge === undefined ||
    !critic.requirement.required ||
    state.planSha256 === undefined
  ) {
    resumeFailure('readiness proof source catalog is incomplete');
  }

  const highRisk = state.riskDomains.some(
    (domain) => domain.applicability === 'applicable' && domain.risk === 'high',
  );
  let versionedReviewMismatch =
    critic.requirement.reason !== 'independent-critic-required' ||
    critic.requirement.expectedBinding.candidate.contentDigest !== state.planSha256 ||
    !bindingMatches(
      critic.requirement.expectedBinding,
      expectedBinding(state, 'critic', critic.requirement.expectedBinding),
    ) ||
    (critic.snapshot === undefined) !== (state.lastCritiquedPlanVersion === undefined);

  if (highRisk) {
    versionedReviewMismatch =
      versionedReviewMismatch ||
      !intermediateJudge.requirement.required ||
      intermediateJudge.requirement.reason !== 'applicable-high-risk-judge-required';
    if (intermediateJudge.requirement.required) {
      versionedReviewMismatch =
        versionedReviewMismatch ||
        intermediateJudge.requirement.expectedBinding.candidate.contentDigest !==
          state.planSha256 ||
        !bindingMatches(
          intermediateJudge.requirement.expectedBinding,
          expectedBinding(
            state,
            'intermediate-judge',
            intermediateJudge.requirement.expectedBinding,
          ),
        );
    }
  } else {
    versionedReviewMismatch =
      versionedReviewMismatch ||
      intermediateJudge.requirement.required ||
      intermediateJudge.requirement.reason !== 'standard-risk-judge-exempt';
  }

  const hasIntermediateJudgeProof = intermediateJudge.snapshot !== undefined;
  const hasFinalJudgeProof = finalJudge.snapshot !== undefined;
  if (
    state.judgeEvaluatedPlanVersion !== undefined &&
    !hasIntermediateJudgeProof &&
    !hasFinalJudgeProof
  ) {
    versionedReviewMismatch = true;
  }
  if (hasIntermediateJudgeProof && state.judgeEvaluatedPlanVersion === undefined) {
    versionedReviewMismatch = true;
  }

  const allowedFixExemptions = new Set([
    'not-required',
    'not-evaluated-for-current-candidate',
    'disabled',
    'no-findings',
    'proposal-failed',
    'review-failed',
    'replacement-rejected',
    'pre-fix-restored',
  ]);
  if (
    (fixReviewer.requirement.required &&
      fixReviewer.requirement.reason !== 'fix-pass-replacement-retained') ||
    (!fixReviewer.requirement.required && !allowedFixExemptions.has(fixReviewer.requirement.reason))
  ) {
    resumeFailure('fix-reviewer source requirement is invalid');
  }

  const fixFinalized =
    fixReviewer.snapshot !== undefined ||
    fixReviewer.requirement.required ||
    !['not-required', 'not-evaluated-for-current-candidate'].includes(
      fixReviewer.requirement.reason,
    );
  const finalJudgeFinalized =
    state.canonicalPlanSha256 !== undefined ||
    finalJudge.snapshot !== undefined ||
    finalJudge.requirement.required ||
    finalJudge.requirement.reason !== 'canonical-plan-not-bound';
  const finalizationProofPresent =
    fixFinalized ||
    finalJudgeFinalized ||
    state.fixReviewerMaterialIssueIds.length > 0 ||
    state.finalJudgeMaterialIssueIds.length > 0 ||
    state.hasCanonicalBindingMismatch ||
    state.hasFreshReviewMismatch ||
    state.hasFinalArtifactMismatch ||
    state.hasJudgeInconsistency;

  for (const source of [fixReviewer, finalJudge]) {
    if (!source.requirement.required) {
      continue;
    }
    if (
      !bindingMatches(
        source.requirement.expectedBinding,
        expectedBinding(state, source.source, source.requirement.expectedBinding),
      )
    ) {
      return { versionedReviewMismatch, finalizationProofPresent: true };
    }
  }
  return { versionedReviewMismatch, finalizationProofPresent };
}

interface ResumePreflight {
  readonly start: number;
  readonly proofFile: string;
  readonly planFile: string;
  readonly selectedPlanSha256: string;
  readonly restored: ReadinessProofState;
  readonly contract: ReadinessContract;
  readonly source: SourcePreflight;
  readonly planChanged: boolean;
  readonly authoritativeChanged: boolean;
  readonly deterministicMismatch: boolean;
}

function preflightResume(ctx: RunContext): ResumePreflight {
  const start = lastStablePlan(ctx);
  const proofFile = path.join(ctx.work, `convergence.v${start}.json`);
  let restored: ReadinessProofState;
  try {
    restored = readReadinessProofState(proofFile);
  } catch {
    resumeFailure('selected readiness proof is invalid (code=proof-invalid)');
  }
  assertCandidateProof(restored, start);
  const contract = readFrozenResumeContract(ctx.work);
  assertCompatibleResumeContract(ctx, restored, contract);
  const planFile = path.join(ctx.work, `plan.v${start}.md`);
  const selectedPlanSha256 = fileSha256(planFile);
  const source = sourcePreflight(restored);
  return {
    start,
    proofFile,
    planFile,
    selectedPlanSha256,
    restored,
    contract,
    source,
    planChanged: restored.planSha256 !== selectedPlanSha256,
    authoritativeChanged:
      restored.authoritativeDigest !== ctx.systemContext.digest ||
      !sameStrings(
        restored.relationshipIds,
        ctx.systemContext.crossRepository
          ? ctx.systemContext.relationships.map((relationship) => relationship.id)
          : [],
      ),
    deterministicMismatch: !systemCheckMatchesState(ctx, restored, planFile, contract),
  };
}

function bindSelectedPlan(
  state: ReadinessProofState,
  planVersion: number,
  planSha256: string,
): ReadinessProofState {
  const critic = createOccurrenceSourceBinding(state, {
    source: 'critic',
    candidateKind: 'versioned-plan',
    contentDigest: planSha256,
  });
  const highRisk = state.riskDomains.some(
    (domain) => domain.applicability === 'applicable' && domain.risk === 'high',
  );
  const intermediateJudge = highRisk
    ? createOccurrenceSourceBinding(state, {
        source: 'intermediate-judge',
        candidateKind: 'versioned-plan',
        contentDigest: planSha256,
      })
    : undefined;
  return bindVersionedPlan(state, {
    planVersion,
    planSha256,
    criticLineageDigest: critic.lineage.lineageDigest,
    ...(intermediateJudge === undefined
      ? {}
      : { intermediateJudgeLineageDigest: intermediateJudge.lineage.lineageDigest }),
  });
}

export function prepareResume(ctx: RunContext): number {
  const preflight = preflightResume(ctx);
  const { start } = preflight;
  const state: ResumeState = { startIter: start, archivedCount: 0, archiveDir: '' };
  archiveResumeStale(ctx.work, state, start);
  reconcileJsonlLedger(ctx.work, state, 'rejected-log.jsonl', (entry) => {
    if (!isJsonObject(entry)) {
      return false;
    }
    return typeof entry.iter === 'number' && entry.iter < start;
  });
  reconcileJsonlLedger(ctx.work, state, 'operator-intervention-migrations.jsonl', (entry) => {
    if (!isJsonObject(entry)) {
      return false;
    }
    const version = planRefVersion(entry.plan_ref);
    return version !== undefined && version <= start;
  });

  let restored = preflight.restored;
  if (preflight.source.finalizationProofPresent) {
    restored = invalidateFinalizationProof(restored);
  }
  if (preflight.authoritativeChanged) {
    restored = recordAuthoritativeContext(restored, {
      authoritativeDigest: ctx.systemContext.digest,
      relationshipIds: ctx.systemContext.crossRepository
        ? ctx.systemContext.relationships.map((relationship) => relationship.id)
        : [],
    });
  }
  const fullReviewInvalidated =
    preflight.planChanged ||
    preflight.authoritativeChanged ||
    preflight.source.versionedReviewMismatch;
  if (fullReviewInvalidated) {
    restored = invalidateFinalizationProof(invalidateFullReviewProof(restored));
    restored = bindSelectedPlan(restored, start, preflight.selectedPlanSha256);
  } else if (preflight.deterministicMismatch) {
    restored = invalidateDeterministicProof(restored);
  }

  const proofChanged = JSON.stringify(restored) !== JSON.stringify(preflight.restored);
  if (proofChanged) {
    archiveResumeSnapshot(ctx.work, state, preflight.proofFile);
  }
  if (fullReviewInvalidated || preflight.deterministicMismatch) {
    archiveResumeFile(ctx.work, state, path.join(ctx.work, `system-check.v${start}.json`));
  }

  ctx.readinessProof = restored;
  ctx.readinessBoundary = preflight.contract.boundary;
  ctx.lastCritiqueIter = Math.max(-1, restored.lastCritiquedPlanVersion ?? start - 1);
  ctx.resume = state;
  writeReadinessProofState(preflight.proofFile, restored);
  if (state.archivedCount > 0) {
    log(`resume archived ${state.archivedCount} stale artifact(s) to ${state.archiveDir}`);
  } else {
    log('resume found no stale artifacts');
  }
  return start;
}
