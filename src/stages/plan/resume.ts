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
import type { ResumeState, RunContext } from '../../core/run-context.js';
import {
  addConvergenceLimit,
  fileSha256,
  requiresSystemCoverage,
  type ConvergenceState,
  readConvergenceState,
  writeConvergenceState,
} from '../../core/convergence.js';
import { isJsonObject, type JsonValue } from '../../core/json.js';
import { readReadinessContract } from '../../core/readiness-contract.js';

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

// Legacy stability is update-based (with v0 as the base); once versioned
// convergence artifacts exist, every selected plan also needs its matching state.
export function lastStablePlan(work: string, creatorSchema: string): number {
  const hasVersionedConvergence = sortedMatches(work, 'convergence.v', '.json').length > 0;
  let best = -1;
  for (const file of sortedMatches(work, 'plan.v', '.md')) {
    const n = artifactVersion(file, 'plan.v', '.md');
    if (n === undefined) {
      continue;
    }
    if (n === 0) {
      const state = readConvergenceState(path.join(work, 'convergence.v0.json'));
      if (!hasVersionedConvergence || state?.planVersion === 0) {
        best = Math.max(best, 0);
      }
      continue;
    }
    const update = path.join(work, `update.v${n - 1}.json`);
    if (!nonEmptyFile(update)) {
      continue;
    }
    if (!schemaValidQuiet(update, creatorSchema)) {
      continue;
    }
    if (hasVersionedConvergence) {
      const state = readConvergenceState(path.join(work, `convergence.v${n}.json`));
      if (state?.planVersion !== n) {
        continue;
      }
    }
    if (n > best) {
      best = n;
    }
  }
  if (best < 0) {
    const message = `resume failed: no stable plan.vN.md found in ${work}`;
    err(message);
    throw new HaltError(message, 4, true);
  }
  return best;
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

function assertCompatibleResumeContract(
  ctx: RunContext,
  restored: ConvergenceState | undefined,
): void {
  if (restored === undefined) {
    const legacySource = path.join(ctx.work, ctx.mode === 'prompt' ? 'prompt.md' : 'plan.v0.md');
    if (existsSync(legacySource) && fileSha256(legacySource) !== ctx.convergence.sourceDigest) {
      const message = 'resume failed: input source differs from the selected legacy run contract';
      err(message);
      throw new HaltError(message, 4, true);
    }
    return;
  }
  const mismatches: string[] = [];
  if (restored.sourceDigest !== ctx.convergence.sourceDigest) {
    mismatches.push('input source');
  }
  if (restored.quality !== ctx.convergence.quality) {
    mismatches.push('quality');
  }
  if (
    restored.promise !== ctx.convergence.promise ||
    restored.requiredProofLevel !== ctx.convergence.requiredProofLevel ||
    restored.requiresExhaustiveScan !== ctx.convergence.requiresExhaustiveScan
  ) {
    mismatches.push('completeness promise');
  }
  if (restored.iterationLimit !== ctx.settings.maxIters) {
    mismatches.push('iteration limit');
  }
  if (
    restored.scopeSource !== ctx.convergence.scopeSource ||
    restored.originalRequestAvailable !== ctx.convergence.originalRequestAvailable
  ) {
    mismatches.push('scope source');
  }
  const frozenContractFile = path.join(ctx.work, 'readiness-contract.json');
  const restoredContractDigest = restored.readinessContractDigest;
  if (existsSync(frozenContractFile)) {
    try {
      const frozenContract = readReadinessContract(frozenContractFile);
      if (
        restoredContractDigest !== undefined &&
        !restoredContractDigest.startsWith('legacy-derived:') &&
        restoredContractDigest !== frozenContract.contractDigest
      ) {
        mismatches.push('readiness contract digest');
      }
    } catch {
      mismatches.push('readiness contract');
    }
  } else if (
    restoredContractDigest !== undefined &&
    !restoredContractDigest.startsWith('legacy-derived:')
  ) {
    mismatches.push('readiness contract');
  }
  if (mismatches.length > 0) {
    const message = `resume failed: ${mismatches.join(', ')} differs from the selected run contract`;
    err(message);
    throw new HaltError(message, 4, true);
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

function systemCheckMatchesPlan(
  work: string,
  planVersion: number,
  state: ConvergenceState,
): boolean {
  const checkFile = path.join(work, `system-check.v${planVersion}.json`);
  const planFile = path.join(work, `plan.v${planVersion}.md`);
  if (!existsSync(checkFile) || !existsSync(planFile)) {
    return false;
  }
  try {
    const check = JSON.parse(readFileSync(checkFile, 'utf8')) as JsonValue;
    const selectedPlanSha256 = fileSha256(planFile);
    return (
      isJsonObject(check) &&
      check.schemaVersion === 1 &&
      check.planVersion === planVersion &&
      check.systemDigest === state.authoritativeDigest &&
      state.planSha256 === selectedPlanSha256 &&
      check.planSha256 === selectedPlanSha256 &&
      check.passed === true &&
      Array.isArray(check.mismatches) &&
      check.mismatches.length === 0 &&
      (!('required' in check) || check.required === requiresSystemCoverage(state)) &&
      (!Array.isArray(check.requiredEvidenceUnavailable) ||
        check.requiredEvidenceUnavailable.length === 0)
    );
  } catch {
    return false;
  }
}

function invalidateRestoredProof(
  state: ConvergenceState,
  planVersion: number,
  marker: string,
): void {
  delete state.canonicalPlanSha256;
  delete state.lastCritiquedPlanVersion;
  delete state.judgeApprovedPlanVersion;
  delete state.judgeEvaluatedPlanVersion;
  delete state.judgeReady;
  state.scanComplete = false;
  state.systemCheckPassed = false;
  state.systemMismatchIds = [];
  state.requiredEvidenceUnavailable = [];
  state.currentActionableIssues = [];
  state.satisfied = false;
  state.decision = 'unable-to-decide';
  state.reasonCodes = ['fresh-review-required'];
  state.stopReason = marker;
  state.unresolvedCoverage = [
    ...new Set([
      ...state.unresolvedCoverage,
      marker,
      `plan.v${planVersion}:not-independently-reviewed`,
      `plan.v${planVersion}:scan-incomplete`,
      `plan.v${planVersion}:system-check`,
      ...state.invariants.map(({ id }) => id),
    ]),
  ];
  for (const invariant of state.invariants) {
    invariant.status = 'active';
    delete invariant.lastReviewedPlanVersion;
    for (const occurrence of invariant.occurrences) {
      occurrence.disposition = 'unresolved';
      occurrence.evidenceRefs = [];
    }
  }
  for (const assessment of state.riskDomains) {
    assessment.complete = false;
    assessment.unavailableEvidence = [];
    delete assessment.lastAssessedPlanVersion;
  }
  state.planVersion = planVersion;
}

function invalidateRestoredSystemCheck(state: ConvergenceState, planVersion: number): void {
  const marker = `plan.v${planVersion}:system-check`;
  state.systemCheckPassed = false;
  state.systemMismatchIds = [];
  state.requiredEvidenceUnavailable = [];
  state.satisfied = false;
  state.decision = 'unable-to-decide';
  state.reasonCodes = ['deterministic-check-incomplete'];
  state.stopReason = marker;
  state.unresolvedCoverage = [...new Set([...state.unresolvedCoverage, marker])];
}

export function prepareResume(ctx: RunContext): number {
  const start = lastStablePlan(ctx.work, ctx.skills.creatorSchema);
  const restored = readConvergenceState(path.join(ctx.work, `convergence.v${start}.json`));
  assertCompatibleResumeContract(ctx, restored);
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
  if (restored !== undefined) {
    ctx.convergence = restored;
    delete restored.canonicalPlanSha256;
    const convergenceFile = path.join(ctx.work, `convergence.v${start}.json`);
    const selectedPlan = path.join(ctx.work, `plan.v${start}.md`);
    const selectedPlanSha256 = fileSha256(selectedPlan);
    if (restored.planSha256 !== selectedPlanSha256) {
      archiveResumeSnapshot(ctx.work, state, convergenceFile);
      archiveResumeFile(ctx.work, state, path.join(ctx.work, `system-check.v${start}.json`));
      const marker = `plan.v${start}:plan-digest-${restored.planSha256 === undefined ? 'unavailable' : 'changed'}`;
      invalidateRestoredProof(restored, start, marker);
      restored.planSha256 = selectedPlanSha256;
    }
    if (
      restored.readinessContractDigest === undefined ||
      restored.readinessContractDigest.startsWith('legacy-derived:')
    ) {
      archiveResumeSnapshot(ctx.work, state, convergenceFile);
      archiveResumeFile(ctx.work, state, path.join(ctx.work, `system-check.v${start}.json`));
      invalidateRestoredProof(restored, start, `plan.v${start}:readiness-contract-proof-unbound`);
    }
    if (restored.systemCheckPassed && !systemCheckMatchesPlan(ctx.work, start, restored)) {
      archiveResumeSnapshot(ctx.work, state, convergenceFile);
      archiveResumeFile(ctx.work, state, path.join(ctx.work, `system-check.v${start}.json`));
      invalidateRestoredSystemCheck(restored, start);
    }
    if (restored.authoritativeDigest !== ctx.systemContext.digest) {
      archiveResumeSnapshot(ctx.work, state, convergenceFile);
      archiveResumeFile(ctx.work, state, path.join(ctx.work, `system-check.v${start}.json`));
      restored.authoritativeDigest = ctx.systemContext.digest;
      restored.relationshipIds = ctx.systemContext.crossRepository
        ? ctx.systemContext.relationships.map((relationship) => relationship.id)
        : [];
      invalidateRestoredProof(restored, start, `plan.v${start}:authoritative-digest-changed`);
      if (restored.readinessContractDigest === undefined) {
        addConvergenceLimit(
          restored,
          'authoritative-scope',
          `plan.v${start}:authoritative-digest-changed`,
        );
      }
    }
  } else {
    ctx.convergence.planVersion = start;
    ctx.convergence.unresolvedCoverage.push(`plan.v${start}:legacy-state-bootstrap`);
    ctx.convergence.stopReason = 'legacy-state-bootstrap';
  }
  ctx.lastCritiqueIter = Math.max(-1, restored?.lastCritiquedPlanVersion ?? start - 1);
  ctx.resume = state;
  writeConvergenceState(ctx.work, ctx.convergence);
  if (state.archivedCount > 0) {
    log(`resume archived ${state.archivedCount} stale artifact(s) to ${state.archiveDir}`);
  } else {
    log('resume found no stale artifacts');
  }
  return start;
}
