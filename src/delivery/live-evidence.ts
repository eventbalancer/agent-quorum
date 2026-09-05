import {
  collectPlanningArtifacts,
  planningArtifactsNeedDecoder,
  parsePlanningArtifactBundle,
} from './evidence-artifacts.js';
import {
  admitProviderArtifactBindings,
  parseLiveProviderProvenance,
  providerEvidenceNeedsDecoder,
  PROVIDER_PROVENANCE_ARTIFACT,
} from './live-provenance-admission.js';
import type { LiveProviderProvenance } from './live-provenance.js';
import {
  decodeApprovedPlanningArtifacts,
  type EvidenceDecoderContext,
} from './evidence-decoder-registry.js';
import type { ExecutionControl } from '../runtime/execution-control.js';
import { readFileSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { fileSha256 } from '../core/digest.js';
import { admitFinalPlan } from '../core/plan-admission.js';
import { readRunRecords } from '../core/run-store.js';
import { DeliveryError, contentDigest } from './contract.js';

import type { ReviewReceipt } from './evidence.js';

export interface LiveReceipt {
  readonly testedRevision: string;
  readonly candidate: string;
  readonly inputDigest: string;
  readonly outputDir: string;
  readonly passedScenarios: readonly string[];
  readonly applicabilityDiffDigest: string;
  readonly reviewerInvocationId: string;
}

export const REQUIRED_LIVE_SCENARIOS = [
  'standard-create-ready',
  'high-revise-judge-ready',
] as const;
const LIVE_INPUTS =
  /^(?:src\/(?:providers|runtime|core|delivery|stages\/plan)\/|skills\/|\.agents\/skills\/|(?:CLAUDE|AGENTS)\.md$|scripts\/benchmark-planning|benchmarks\/planning\/|package\.json$|pnpm-lock\.yaml$|config\.example\.json$)/;
const ORDINARY_DOCUMENTATION =
  /^(?:README\.md$|docs\/(?!development\/(?:agent-skill-flow|conventions)|release\.md|configuration\.md|architecture\.md|cli\.md|api\.md).+\.md$)/;

export function needsLiveGate(paths: readonly string[], uncertainty: string): boolean {
  return uncertainty.trim() !== '' || paths.some((file) => LIVE_INPUTS.test(file));
}

export function isLiveReuseEligible(paths: readonly string[]): boolean {
  return paths.every((file) => ORDINARY_DOCUMENTATION.test(file));
}

export function admitLiveReceipt(
  receipt: LiveReceipt,
  candidate: string,
  inputDigest: string,
  review: ReviewReceipt,
): void {
  if (
    receipt.inputDigest === '' ||
    receipt.inputDigest !== inputDigest ||
    !isRevision(receipt.testedRevision) ||
    !path.isAbsolute(receipt.outputDir) ||
    !exactScenarios(receipt.passedScenarios)
  ) {
    throw new DeliveryError('required-live-gate-incomplete');
  }
  if (receipt.candidate === candidate) {
    return;
  }
  const hasCurrentApplicability =
    review.candidate === candidate &&
    review.approved &&
    review.invocationId.trim() !== '' &&
    review.implementationInvocationId.trim() !== '' &&
    review.invocationId !== review.implementationInvocationId &&
    review.liveReuseApproved &&
    isSha256(receipt.applicabilityDiffDigest) &&
    review.interveningDiffDigest === receipt.applicabilityDiffDigest &&
    review.invocationId === receipt.reviewerInvocationId;
  if (!hasCurrentApplicability) {
    throw new DeliveryError('stale-live-evidence');
  }
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactScenarios(value: readonly string[]): boolean {
  return (
    value.length === REQUIRED_LIVE_SCENARIOS.length &&
    REQUIRED_LIVE_SCENARIOS.every(
      (id) => value.filter((candidate) => candidate === id).length === 1,
    )
  );
}

export interface LiveExecutionReceipt {
  readonly testedRevision: string;
  readonly receiptSha256: string;
  readonly attemptsSha256: string;
  readonly providerConfigSha256: string;
  readonly passedScenarios: readonly string[];
  readonly finalPlanDigests: Readonly<Record<string, string>>;
}

function samePhysicalPath(left: string, right: string): boolean {
  try {
    return realpathSync(left) === realpathSync(right);
  } catch {
    return false;
  }
}

function privateArtifact(outputDir: string, relative: unknown): string {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) {
    throw new DeliveryError('invalid-live-artifact-path');
  }
  const root = realpathSync(outputDir);
  const artifact = realpathSync(path.resolve(root, relative));
  if (!artifact.startsWith(`${root}${path.sep}`)) {
    throw new DeliveryError('live-artifact-outside-output');
  }
  return artifact;
}

export async function validateLiveExecutionSummary(
  stdout: string,
  outputDir: string,
  expectedImplementation?: string,
  decoder?: {
    readonly decoderContext: EvidenceDecoderContext;
    readonly execution: ExecutionControl;
  },
): Promise<LiveExecutionReceipt> {
  try {
    const summary: unknown = JSON.parse(stdout.trim());
    const receiptFile = path.join(outputDir, 'smoke-results.json');
    const attemptsFile = path.join(outputDir, 'smoke-attempts.json');
    if (
      !isObject(summary) ||
      summary.schemaVersion !== 1 ||
      summary.passed !== true ||
      !isRevision(summary.workspaceRevision) ||
      !isSha256(summary.receiptSha256) ||
      !isSha256(summary.attemptsSha256) ||
      summary.receiptSha256 !== fileSha256(receiptFile) ||
      summary.attemptsSha256 !== fileSha256(attemptsFile) ||
      (expectedImplementation !== undefined &&
        summary.workspaceRevision !== expectedImplementation) ||
      !Array.isArray(summary.scenarios)
    ) {
      throw new DeliveryError('unadmitted-live-execution-summary');
    }
    const scenarios = summary.scenarios.map((value: unknown) => {
      if (!isObject(value) || typeof value.id !== 'string' || value.passed !== true) {
        throw new DeliveryError('unadmitted-live-scenario-summary');
      }
      return value.id;
    });
    if (!exactScenarios(scenarios)) {
      throw new DeliveryError('required-live-gate-incomplete');
    }
    const receipt: unknown = JSON.parse(readFileSync(receiptFile, 'utf8'));
    const attempts: unknown = JSON.parse(readFileSync(attemptsFile, 'utf8'));
    if (
      !isObject(receipt) ||
      receipt.schemaVersion !== 1 ||
      receipt.passed !== true ||
      receipt.workspaceRevision !== summary.workspaceRevision ||
      !isSha256(receipt.providerConfigSha256) ||
      !Array.isArray(receipt.tasks) ||
      receipt.tasks.length !== REQUIRED_LIVE_SCENARIOS.length ||
      !isObject(attempts) ||
      attempts.schemaVersion !== 1 ||
      attempts.suiteId !== receipt.suiteId ||
      !Array.isArray(attempts.attempts)
    ) {
      throw new DeliveryError('invalid-live-execution-receipt');
    }
    const finalPlanDigests: Record<string, string> = {};
    for (const value of receipt.tasks as unknown[]) {
      if (
        !isObject(value) ||
        typeof value.taskId !== 'string' ||
        !scenarios.includes(value.taskId) ||
        value.passed !== true ||
        value.exitCode !== 0 ||
        value.decision !== 'ready' ||
        !isSha256(value.finalPlanSha256) ||
        !isSha256(value.artifactBundleSha256)
      ) {
        throw new DeliveryError('invalid-live-scenario-receipt');
      }
      const planFile = privateArtifact(outputDir, value.finalPlan);
      if (fileSha256(planFile) !== value.finalPlanSha256) {
        throw new DeliveryError('stale-live-plan-artifact');
      }
      const workDir = path.dirname(planFile);
      const matching = attempts.attempts.filter(
        (entry: unknown) =>
          isObject(entry) &&
          typeof entry.workDir === 'string' &&
          samePhysicalPath(entry.workDir, workDir) &&
          entry.scenarioId === value.taskId &&
          entry.workspaceRevision === summary.workspaceRevision &&
          entry.exitCode === 0 &&
          entry.artifactBundleSha256 === value.artifactBundleSha256 &&
          isSha256(entry.identity),
      );
      if (matching.length !== 1) {
        throw new DeliveryError('live-attempt-provenance-missing');
      }
      const input = collectPlanningArtifacts(
        workDir,
        path.join(path.dirname(workDir), 'state'),
        path.join(path.dirname(workDir), 'input.md'),
      );
      if (contentDigest(input) !== value.artifactBundleSha256) {
        throw new DeliveryError('stale-live-artifact-bundle');
      }
      const provenanceText = parsePlanningArtifactBundle(input).files[PROVIDER_PROVENANCE_ARTIFACT];
      const originalAttempt: unknown = matching[0];
      if (
        provenanceText === undefined ||
        !isObject(originalAttempt) ||
        typeof originalAttempt.identity !== 'string'
      ) {
        throw new DeliveryError('live-provider-provenance-missing');
      }
      const standard = value.taskId === 'standard-create-ready';
      const provenance = parseLiveProviderProvenance(provenanceText, {
        id: value.taskId,
        inputMode: standard ? 'prompt' : 'plan',
        quality: standard ? 'quick' : 'balanced',
        maxIterations: standard ? 2 : 3,
        workDir,
        inputSha256: fileSha256(path.join(path.dirname(workDir), 'input.md')),
        workspaceRevision: summary.workspaceRevision,
        attemptIdentity: originalAttempt.identity,
        providerConfigSha256: receipt.providerConfigSha256,
        ...(decoder === undefined ? {} : { controllerDigest: decoder.decoderContext.policyDigest }),
      });
      const records = readRunRecords(path.join(path.dirname(workDir), 'state')).filter((record) =>
        samePhysicalPath(record.workDir, workDir),
      );
      const record = records[0];
      if (
        records.length !== 1 ||
        record === undefined ||
        !admitFinalPlan({ workDir, record }).admitted ||
        providerEvidenceNeedsDecoder(provenance)
      ) {
        if (
          (!planningArtifactsNeedDecoder(input) && !providerEvidenceNeedsDecoder(provenance)) ||
          decoder?.decoderContext.producerRevision !== summary.workspaceRevision
        ) {
          throw new DeliveryError('live-plan-readiness-not-admitted');
        }
        await decodeApprovedPlanningArtifacts(
          decoder.decoderContext,
          input,
          decoder.execution,
          (projectedWorkDir) => {
            const projectedProvenance = JSON.parse(
              readFileSync(
                path.join(path.dirname(projectedWorkDir), PROVIDER_PROVENANCE_ARTIFACT),
                'utf8',
              ),
            ) as LiveProviderProvenance;
            admitProviderArtifactBindings(projectedWorkDir, projectedProvenance);
          },
        );
      } else {
        admitProviderArtifactBindings(workDir, provenance);
      }
      if (finalPlanDigests[value.taskId] !== undefined) {
        throw new DeliveryError('duplicate-live-scenario');
      }
      finalPlanDigests[value.taskId] = value.finalPlanSha256;
    }
    if (!exactScenarios(Object.keys(finalPlanDigests))) {
      throw new DeliveryError('required-live-gate-incomplete');
    }
    return {
      testedRevision: summary.workspaceRevision,
      receiptSha256: summary.receiptSha256,
      attemptsSha256: summary.attemptsSha256,
      providerConfigSha256: receipt.providerConfigSha256,
      passedScenarios: scenarios,
      finalPlanDigests,
    };
  } catch (error) {
    if (error instanceof DeliveryError) {
      throw error;
    }
    throw new DeliveryError('invalid-live-execution-evidence');
  }
}
