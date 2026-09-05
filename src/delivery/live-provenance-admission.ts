import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { canonicalJsonSha256, fileSha256, sha256 } from '../core/digest.js';
import type { JsonValue } from '../core/json.js';
import { admitCritique, admitFixReviewer, admitJudge } from '../core/readiness-admission.js';
import { parseReadinessAssessment, readReadinessContract } from '../core/readiness-contract.js';
import { createOccurrenceSourceBinding } from '../core/readiness-proof.js';
import { readReadinessProofState } from '../core/readiness-store.js';
import {
  sanitizeCritiqueJson,
  sanitizeUpdateJson,
  sanitizeUpdateMetaJson,
} from '../core/schema.js';
import {
  normalizePlanDocument,
  normalizeRepositoryFileLineReferences,
} from '../stages/plan/plan-shape.js';
import { DeliveryError } from './contract.js';
import type {
  LiveProviderCall,
  LiveProviderProvenance,
  LiveProviderRole,
} from './live-provenance.js';

export const PROVIDER_PROVENANCE_ARTIFACT = 'provider-provenance.json';

export interface LiveProvenanceExpectation {
  readonly id: string;
  readonly inputMode: string;
  readonly quality: string;
  readonly maxIterations: number;
  readonly workDir: string;
  readonly inputSha256: string;
  readonly workspaceRevision?: string;
  readonly attemptIdentity?: string;
  readonly controllerDigest?: string;
  readonly profileDigest?: string;
  readonly providerConfigSha256?: string;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failure(code: string): never {
  throw new DeliveryError(`live-provider-${code}`);
}

export function parseLiveProviderProvenance(
  text: string,
  expected: LiveProvenanceExpectation,
): LiveProviderProvenance {
  try {
    const value: unknown = JSON.parse(text);
    if (
      !object(value) ||
      value.version !== 1 ||
      !object(value.scenario) ||
      value.exitCode !== 0 ||
      typeof value.completedAt !== 'string' ||
      !Number.isFinite(Date.parse(value.completedAt)) ||
      !Array.isArray(value.calls) ||
      value.calls.length === 0 ||
      value.calls.length > 1000
    ) {
      return failure('provenance-incomplete');
    }
    for (const [key, entry] of Object.entries(expected)) {
      if (
        key === 'workDir' &&
        typeof value.scenario[key] === 'string' &&
        realpathSync(value.scenario[key]) === realpathSync(String(entry))
      ) {
        continue;
      }
      if (value.scenario[key] !== entry) {
        failure(`scenario-mismatch:${key}`);
      }
    }
    for (const [index, call] of value.calls.entries()) {
      if (
        !object(call) ||
        call.id !== index + 1 ||
        typeof call.role !== 'string' ||
        typeof call.prompt !== 'string' ||
        call.promptSha256 !== sha256(call.prompt) ||
        call.schemaSha256 !== canonicalJsonSha256(call.schema) ||
        !Array.isArray(call.starts) ||
        call.starts.some(
          (start: unknown) =>
            !object(start) ||
            typeof start.pid !== 'number' ||
            !Number.isSafeInteger(start.pid) ||
            start.pid <= 0 ||
            typeof start.pgid !== 'string' ||
            typeof start.procStartToken !== 'string' ||
            typeof start.startedAt !== 'string',
        ) ||
        (call.status === 0 &&
          (call.starts.length === 0 ||
            typeof call.output !== 'string' ||
            call.outputSha256 !== sha256(call.output)))
      ) {
        failure('call-provenance-invalid');
      }
    }
    return value as unknown as LiveProviderProvenance;
  } catch (error) {
    if (error instanceof DeliveryError) {
      throw error;
    }
    return failure('provenance-invalid');
  }
}

export function assertProviderProjection(
  original: string | undefined,
  projected: string | undefined,
): void {
  if (original === undefined && projected === undefined) {
    return;
  }
  if (original === undefined || projected === undefined) {
    failure('projection-call-set-changed');
  }
  const left: unknown = JSON.parse(original);
  const right: unknown = JSON.parse(projected);
  if (
    !object(left) ||
    !object(right) ||
    !Array.isArray(left.calls) ||
    !Array.isArray(right.calls) ||
    left.calls.length !== right.calls.length
  ) {
    failure('projection-call-set-changed');
  }
  const withoutOutputs = (receipt: Record<string, unknown>): unknown => ({
    ...receipt,
    calls: (receipt.calls as unknown[]).map((call) => {
      if (!object(call)) {
        return failure('projection-call-invalid');
      }
      const retained = { ...call };
      Reflect.deleteProperty(retained, 'output');
      return retained;
    }),
  });
  if (canonicalJsonSha256(withoutOutputs(left)) !== canonicalJsonSha256(withoutOutputs(right))) {
    failure('projection-trusted-metadata-changed');
  }
}

export function providerEvidenceNeedsDecoder(provenance: LiveProviderProvenance): boolean {
  const frozenRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  return provenance.calls.some((call) => {
    const contract = call.contract;
    if (contract === undefined) {
      return false;
    }
    if (!/^skills\/(?:plan-[a-z-]+|_shared)\/[a-z-]+\.schema\.json$/.test(contract.schemaFile)) {
      return true;
    }
    const file = path.join(frozenRoot, contract.schemaFile);
    return !existsSync(file) || fileSha256(file) !== contract.sourceSchemaSha256;
  });
}

function json(text: string): JsonValue {
  return JSON.parse(text) as JsonValue;
}

function equal(left: unknown, right: unknown): boolean {
  return canonicalJsonSha256(left) === canonicalJsonSha256(right);
}

function normalizedOutput(call: LiveProviderCall, name: string, scratch: string): unknown {
  if (call.output === undefined) {
    return null;
  }
  const raw = json(call.output);
  if (
    (name.startsWith('critique.v') && (!object(raw) || !object(raw.review))) ||
    (name.startsWith('update.v') && (!object(raw) || typeof raw.plan_markdown !== 'string')) ||
    (name.startsWith('update-meta.v') &&
      (!object(raw) || typeof raw.plan_version !== 'number' || 'plan_markdown' in raw))
  ) {
    return null;
  }
  const file = path.join(scratch, 'response.json');
  writeFileSync(file, call.output);
  if (/^critique\.v[0-9]+\.json$/.test(name)) {
    sanitizeCritiqueJson(file);
  }
  if (/^update\.v[0-9]+\.json$/.test(name)) {
    sanitizeUpdateJson(file);
  }
  if (/^update-meta\.v[0-9]+\.json$/.test(name)) {
    sanitizeUpdateMetaJson(file);
  }
  return json(readFileSync(file, 'utf8'));
}

function trimmed(value: string): string {
  return value.replace(/\n+$/, '');
}

function reviewedContent(value: string): string {
  return value.replace(
    /^status:[ \t]+(?:clean|needs-review|blocked)[ \t]*\r?$/m,
    'status: <orchestration-projection>',
  );
}

export function admitProviderArtifactBindings(
  workDir: string,
  provenance: LiveProviderProvenance,
): void {
  const scratch = mkdtempSync(path.join(os.tmpdir(), 'delivery-provider-admission-'));
  try {
    const source = readFileSync(path.join(path.dirname(workDir), 'input.md'), 'utf8');
    const proof = readReadinessProofState(path.join(workDir, 'convergence.final.json'));
    const contract = readReadinessContract(path.join(workDir, 'readiness-contract.json'));
    if (
      sha256(source) !== provenance.scenario.inputSha256 ||
      proof.sourceDigest !== provenance.scenario.inputSha256 ||
      contract.sourceDigest !== provenance.scenario.inputSha256 ||
      contract.appetite.quality !== provenance.scenario.quality ||
      contract.appetite.iterationLimit !== provenance.scenario.maxIterations
    ) {
      failure('source-binding-mismatch');
    }
    const calls = provenance.calls.filter(
      (call) =>
        call.status === 0 &&
        call.starts.length > 0 &&
        call.output !== undefined &&
        call.role !== 'unknown',
    );
    const read = (name: string): string => readFileSync(path.join(workDir, name), 'utf8');
    const matchJson = (
      name: string,
      role: LiveProviderRole,
      candidate?: string,
    ): LiveProviderCall => {
      const artifact = json(read(name));
      const found = calls.find((call) => {
        if (
          call.role !== role ||
          (candidate !== undefined && !call.prompt.includes(trimmed(candidate)))
        ) {
          return false;
        }
        try {
          return equal(normalizedOutput(call, name, scratch), artifact);
        } catch {
          return false;
        }
      });
      return found ?? failure(`artifact-not-produced:${name}`);
    };
    const matchesMarkdown = (name: string, role: LiveProviderRole): boolean =>
      calls.some((call) => {
        if (call.role !== role || call.output === undefined) {
          return false;
        }
        try {
          const output = json(call.output);
          if (!object(output) || typeof output.plan_markdown !== 'string') {
            return false;
          }
          const file = path.join(scratch, 'plan.md');
          writeFileSync(file, output.plan_markdown);
          normalizePlanDocument(file);
          normalizeRepositoryFileLineReferences(file, provenance.scenario.repositoryRoot);
          return trimmed(readFileSync(file, 'utf8')) === trimmed(read(name));
        } catch {
          return false;
        }
      });
    matchJson('readiness-assessment.initial.json', 'creator', source);
    const assessment = parseReadinessAssessment(read('readiness-assessment.initial.json'));
    if (
      !equal(assessment.boundary, contract.boundary) ||
      !equal(assessment.domainAssessments, contract.domainAssessments) ||
      !equal(assessment.unresolvedMaterialQuestions, contract.unresolvedMaterialQuestions)
    ) {
      failure('assessment-contract-mismatch');
    }
    if (provenance.scenario.inputMode === 'prompt') {
      if (!matchesMarkdown('plan.v0.md', 'creator')) {
        failure('initial-plan-not-produced');
      }
    } else if (trimmed(read('plan.v0.md')) !== trimmed(source)) {
      failure('direct-plan-source-mismatch');
    }
    for (let version = 0; version <= proof.planVersion; version += 1) {
      matchJson(`critique.v${version}.json`, 'critic', read(`plan.v${version}.md`));
      if (version === 0) {
        continue;
      }
      const updateFile = `update.v${version - 1}.json`;
      const metadataFile = `update-meta.v${version - 1}.json`;
      const update = json(read(updateFile));
      const metadata = json(read(metadataFile));
      const oneShot = calls.some((call) => {
        if (
          call.role !== 'creator' ||
          !call.prompt.includes(trimmed(read(`plan.v${version - 1}.md`)))
        ) {
          return false;
        }
        try {
          return equal(normalizedOutput(call, updateFile, scratch), update);
        } catch {
          return false;
        }
      });
      if (!oneShot) {
        matchJson(metadataFile, 'creator', read(`plan.v${version}.md`));
        if (!matchesMarkdown(`plan.v${version}.md`, 'creator')) {
          failure('revised-plan-not-produced');
        }
      }
      if (!object(update) || typeof update.plan_markdown !== 'string' || !object(metadata)) {
        failure('revision-evidence-invalid');
      }
      const planFile = path.join(scratch, 'revision.md');
      writeFileSync(planFile, update.plan_markdown);
      normalizePlanDocument(planFile);
      normalizeRepositoryFileLineReferences(planFile, provenance.scenario.repositoryRoot);
      if (trimmed(readFileSync(planFile, 'utf8')) !== trimmed(read(`plan.v${version}.md`))) {
        failure('revision-plan-mismatch');
      }
      const projectedMetadata = { ...update };
      Reflect.deleteProperty(projectedMetadata, 'plan_markdown');
      if (!equal(projectedMetadata, metadata)) {
        failure('revision-metadata-mismatch');
      }
    }
    const planFile = path.join(workDir, `plan.v${proof.planVersion}.md`);
    const criticBinding = createOccurrenceSourceBinding(proof, {
      source: 'critic',
      candidateKind: 'versioned-plan',
      contentDigest: fileSha256(planFile),
    });
    const evidenceContext = {
      work: workDir,
      projectRoot: provenance.scenario.repositoryRoot,
      planVersion: proof.planVersion,
      candidateContent: readFileSync(planFile, 'utf8'),
      candidatePath: planFile,
    };
    const critique = admitCritique({
      value: json(read(`critique.v${proof.planVersion}.json`)),
      catalog: proof.catalog,
      binding: criticBinding,
      evidenceContext,
      expectedScopeToken:
        provenance.scenario.inputMode === 'prompt' ? 'original-scope' : 'direct-plan-scope',
      issueBudgetLimit: proof.issueBudget.limit,
      currentRiskDomains: proof.riskDomains,
      admittedPriorIssueRefs: proof.admittedCriticIssueRefs.filter(
        (ref) => !ref.startsWith(`v${proof.planVersion}.`),
      ),
    });
    if (
      !equal(critique.snapshot, proof.sources.find((slot) => slot.source === 'critic')?.snapshot) ||
      !equal(critique.materialIssueIds, proof.criticMaterialIssueIds) ||
      !critique.scanComplete ||
      !equal(critique.riskDomains, proof.riskDomains)
    ) {
      failure('critic-proof-not-derived');
    }
    for (const slot of proof.sources) {
      if (!slot.requirement.required || slot.source === 'critic') {
        continue;
      }
      const sourceKind = slot.source;
      const candidateName =
        sourceKind === 'intermediate-judge'
          ? `plan.v${proof.planVersion}.md`
          : sourceKind === 'final-judge'
            ? 'plan.final.md'
            : slot.requirement.expectedBinding.candidate.kind === 'fix-proposal'
              ? 'fix-proposal.md'
              : 'fix-applied.md';
      const candidateFile = path.join(workDir, candidateName);
      const candidateContent = read(candidateName);
      const binding = createOccurrenceSourceBinding(proof, {
        source: sourceKind,
        candidateKind: slot.requirement.expectedBinding.candidate.kind,
        contentDigest: fileSha256(candidateFile),
      });
      const context = { ...evidenceContext, candidateContent, candidatePath: candidateFile };
      if (sourceKind === 'fix-reviewer') {
        if (!matchesMarkdown(candidateName, 'fixer')) {
          failure('fix-candidate-not-produced');
        }
        const name =
          candidateName === 'fix-proposal.md' ? 'fix-review.json' : 'fix-applied-review.json';
        matchJson(name, 'reviewer', candidateContent);
        const review = admitFixReviewer({
          value: json(read(name)),
          catalog: proof.catalog,
          binding,
          evidenceContext: context,
          requirementReason: slot.requirement.reason,
        });
        if (!review.satisfied || !equal(review.snapshot, slot.snapshot)) {
          failure('reviewer-proof-not-derived');
        }
      } else {
        const name =
          sourceKind === 'final-judge' ? 'judge.final.json' : `judge.v${proof.planVersion}.json`;
        matchJson(name, 'judge', candidateContent);
        const judge = admitJudge({
          value: json(read(name)),
          stage: sourceKind === 'final-judge' ? 'final' : 'intermediate',
          catalog: proof.catalog,
          binding,
          evidenceContext: context,
        });
        if (!judge.verdict || !judge.satisfied || !equal(judge.snapshot, slot.snapshot)) {
          failure('judge-proof-not-derived');
        }
      }
    }
    const fixSource = proof.sources.find((slot) => slot.source === 'fix-reviewer');
    const independentlyReviewed =
      fixSource?.requirement.required === true
        ? fixSource.requirement.expectedBinding.candidate.kind === 'fix-proposal'
          ? 'fix-proposal.md'
          : 'fix-applied.md'
        : `plan.v${proof.planVersion}.md`;
    if (reviewedContent(read('plan.final.md')) !== reviewedContent(read(independentlyReviewed))) {
      failure('canonical-plan-not-reviewed');
    }
    if (provenance.scenario.quality === 'quick' && calls.some((call) => call.role === 'judge')) {
      failure('forbidden-judge-call');
    }
  } catch (error) {
    if (error instanceof DeliveryError) {
      throw error;
    }
    failure('artifact-binding-invalid');
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
