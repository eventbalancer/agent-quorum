import {
  DeliveryError,
  digest,
  type AcceptanceCriterion,
  type DeliveryFinding,
} from './contract.js';

export interface CheckReceipt {
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly outputDigest: string;
}

export interface ReviewFinding {
  readonly id: string;
  readonly material: boolean;
  readonly description: string;
  readonly evidence: readonly string[];
  readonly resolution: 'open' | 'corrected' | 'dismissed';
  readonly resolutionEvidence: readonly string[];
}

export interface ReviewReceipt {
  readonly invocationId: string;
  readonly implementationInvocationId: string;
  readonly candidate: string;
  readonly acceptanceDigest: string;
  readonly approved: boolean;
  readonly findings: readonly ReviewFinding[];
  readonly acceptanceEvidence: readonly AcceptanceCriterion[];
  readonly adjacentFindings: readonly DeliveryFinding[];
  readonly liveReuseApproved: boolean;
  readonly interveningDiffDigest: string;
}

export interface VerificationReceipt {
  readonly candidate: string;
  readonly inputsDigest: string;
  readonly policyDigest: string;
  readonly checks: readonly CheckReceipt[];
}

export function admitReview(
  review: ReviewReceipt,
  candidate: string,
  acceptance: readonly AcceptanceCriterion[],
): void {
  const isDistinct =
    review.invocationId.trim() !== '' &&
    review.implementationInvocationId.trim() !== '' &&
    review.invocationId !== review.implementationInvocationId;
  if (
    !isDistinct ||
    review.candidate !== candidate ||
    review.acceptanceDigest !== digest(acceptance)
  ) {
    throw new DeliveryError('stale-or-nonindependent-review');
  }
  if (
    !review.approved ||
    review.findings.some(
      (finding) =>
        finding.material &&
        (finding.resolution === 'open' || !hasEvidence(finding.resolutionEvidence)),
    )
  ) {
    throw new DeliveryError('material-review-findings');
  }
  if (
    acceptance.length === 0 ||
    new Set(acceptance.map((criterion) => criterion.id)).size !== acceptance.length ||
    new Set(review.acceptanceEvidence.map((criterion) => criterion.id)).size !==
      review.acceptanceEvidence.length ||
    acceptance.some(
      (criterion) =>
        !review.acceptanceEvidence.some(
          (assessed) =>
            assessed.id === criterion.id &&
            assessed.outcome === criterion.outcome &&
            hasEvidence(assessed.evidence),
        ),
    )
  ) {
    throw new DeliveryError('acceptance-evidence-incomplete');
  }
}

export function admitVerification(
  receipt: VerificationReceipt,
  candidate: string,
  inputsDigest: string,
  policyDigest: string,
  requiresTests: boolean,
): void {
  if (
    receipt.candidate !== candidate ||
    receipt.inputsDigest !== inputsDigest ||
    receipt.policyDigest !== policyDigest
  ) {
    throw new DeliveryError('stale-verification');
  }
  const required = ['check', ...(requiresTests ? ['test'] : [])];
  if (
    receipt.checks.some((check) => check.exitCode !== 0) ||
    required.some(
      (name) =>
        !receipt.checks.some(
          (check) =>
            check.command.length === 3 &&
            check.command[0] === 'pnpm' &&
            check.command[1] === 'run' &&
            check.command[2] === name &&
            check.exitCode === 0 &&
            isSha256(check.outputDigest),
        ),
    )
  ) {
    throw new DeliveryError('required-local-check-missing');
  }
}

export interface CanonicalPlanEvidence {
  readonly version: 1;
  readonly candidate: string;
  readonly artifactDigest: string;
  readonly schemaVersions: readonly number[];
  readonly ready: boolean;
  readonly exactBindings: boolean;
  readonly requiredSourcesPresent: boolean;
  readonly aggregateConsistent: boolean;
  readonly judgeSatisfied: boolean;
}

export const DECODER_NEGATIVE_CASES = [
  'malformed',
  'unsupported',
  'forged-aggregate',
  'missing-source',
  'stale-hash',
  'projection-disagreement',
  'missing-judge',
  'negative-readiness',
] as const;

export interface DecoderCaseReceipt {
  readonly name: string;
  readonly inputDigest: string;
  readonly outputDigest: string;
  readonly admitted: boolean;
}

export interface DecoderAdmission {
  readonly decoderDigest: string;
  readonly candidate: string;
  readonly independentReview: ReviewReceipt;
  readonly fixtureSetDigest: string;
  readonly conformance: readonly DecoderCaseReceipt[];
  readonly policyDigest: string;
}

export function admitDecoder(
  admission: DecoderAdmission,
  candidate: string,
  policyDigest: string,
): void {
  if (
    admission.candidate !== candidate ||
    admission.policyDigest !== policyDigest ||
    admission.independentReview.candidate !== candidate ||
    !admission.independentReview.approved ||
    admission.independentReview.invocationId.trim() === '' ||
    admission.independentReview.implementationInvocationId.trim() === '' ||
    admission.independentReview.invocationId ===
      admission.independentReview.implementationInvocationId ||
    admission.independentReview.findings.some(
      (finding) =>
        finding.material &&
        (finding.resolution === 'open' || !hasEvidence(finding.resolutionEvidence)),
    ) ||
    !isSha256(admission.decoderDigest) ||
    !isSha256(admission.fixtureSetDigest) ||
    admission.conformance.length !== DECODER_NEGATIVE_CASES.length + 1 ||
    !['valid', ...DECODER_NEGATIVE_CASES].every((name) => {
      const cases = admission.conformance.filter((entry) => entry.name === name);
      const result = cases[0];
      return (
        cases.length === 1 &&
        result !== undefined &&
        isSha256(result.inputDigest) &&
        isSha256(result.outputDigest) &&
        result.admitted === (name === 'valid')
      );
    })
  ) {
    throw new DeliveryError('unadmitted-evidence-decoder');
  }
}

function isEnvelopeVersion(version: number): boolean {
  return version === 1;
}

export function admitCanonicalPlan(
  envelope: CanonicalPlanEvidence,
  candidate: string,
  artifactDigest: string,
): void {
  const isReady =
    isEnvelopeVersion(envelope.version) &&
    envelope.candidate === candidate &&
    envelope.artifactDigest === artifactDigest &&
    isSha256(artifactDigest) &&
    envelope.schemaVersions.length > 0 &&
    envelope.schemaVersions.every((version) => Number.isSafeInteger(version) && version > 0) &&
    envelope.ready &&
    envelope.exactBindings &&
    envelope.requiredSourcesPresent &&
    envelope.aggregateConsistent &&
    envelope.judgeSatisfied;
  if (!isReady) {
    throw new DeliveryError('unadmitted-canonical-plan-evidence');
  }
}

function hasEvidence(evidence: readonly string[]): boolean {
  return evidence.length > 0 && evidence.every((entry) => entry.trim() !== '');
}

function isSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}
