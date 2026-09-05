import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  renameSync,
  rmSync,
  openSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { DeliveryError, digest, type Mandate } from './contract.js';
import {
  withPlanningArtifactProjection,
  type PlanningArtifactProjection,
} from './evidence-artifacts.js';
import {
  evidenceDecoderAcceptance,
  evidenceDecoderFixtureDigest,
  runReviewedEvidenceDecoder,
  type EvidenceDecoderExecutor,
  type EvidenceDecoderFixture,
  type ReviewedEvidenceDecoderResult,
} from './evidence-decoder.js';
import { admitReview, type ReviewReceipt } from './evidence.js';
import { fileSha256 } from '../core/digest.js';
import type { ExecutionControl } from '../runtime/execution-control.js';

export interface EvidenceDecoderProposal {
  readonly decoderFile: string;
  readonly decoderDigest: string;
  readonly fixtures: readonly EvidenceDecoderFixture[];
  readonly fixtureSetDigest: string;
}

export interface EvidenceDecoderContext {
  readonly registryRoot: string;
  readonly producerRevision: string;
  readonly policyDigest: string;
  readonly timeoutMs: number;
}

export interface ApprovedEvidenceDecoder {
  readonly version: 1;
  readonly producerRevision: string;
  readonly reviewCandidate: string;
  readonly policyDigest: string;
  readonly decoderDigest: string;
  readonly fixtureSetDigest: string;
  readonly independentReview: ReviewReceipt;
}

export interface AdoptEvidenceDecoderOptions extends EvidenceDecoderContext {
  readonly reviewCandidate: string;
  readonly proposal: EvidenceDecoderProposal;
  readonly independentReview: ReviewReceipt;
  readonly execution: ExecutionControl;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseFixtures(value: unknown): readonly EvidenceDecoderFixture[] {
  if (
    !Array.isArray(value) ||
    value.some(
      (fixture: unknown) =>
        !object(fixture) ||
        Object.keys(fixture).length !== 2 ||
        typeof fixture.name !== 'string' ||
        typeof fixture.input !== 'string',
    )
  ) {
    throw new DeliveryError('invalid-decoder-fixtures');
  }
  return value as EvidenceDecoderFixture[];
}

function regularJson(file: string, ownerOnly: boolean): unknown {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.size > 16 * 1024 * 1024 ||
      (ownerOnly && ((stat.mode & 0o077) !== 0 || stat.uid !== process.getuid?.()))
    ) {
      throw new DeliveryError('invalid-decoder-descriptor-file');
    }
    return JSON.parse(readFileSync(fd, 'utf8')) as unknown;
  } finally {
    closeSync(fd);
  }
}

export function readEvidenceDecoderProposal(
  repositoryRoot: string,
): EvidenceDecoderProposal | undefined {
  const root = path.join(repositoryRoot, 'skills/evidence-decoder');
  const descriptor = path.join(root, 'descriptor.json');
  if (!existsSync(descriptor)) {
    return undefined;
  }
  if (!realpathSync(root).startsWith(`${realpathSync(repositoryRoot)}${path.sep}`)) {
    throw new DeliveryError('decoder-proposal-outside-candidate');
  }
  const value = regularJson(descriptor, false);
  if (
    !object(value) ||
    Object.keys(value).length !== 3 ||
    value.schemaVersion !== 1 ||
    value.decoderFile !== 'decoder.mjs' ||
    value.fixturesFile !== 'fixtures.json'
  ) {
    throw new DeliveryError('invalid-proposed-decoder-descriptor');
  }
  const decoderFile = path.join(root, 'decoder.mjs');
  const fixtures = parseFixtures(regularJson(path.join(root, 'fixtures.json'), false));
  return {
    decoderFile,
    decoderDigest: fileSha256(decoderFile),
    fixtures,
    fixtureSetDigest: evidenceDecoderFixtureDigest(fixtures),
  };
}

function descriptorDirectory(context: EvidenceDecoderContext): string {
  if (
    !path.isAbsolute(context.registryRoot) ||
    !/^[a-f0-9]{40}$/.test(context.producerRevision) ||
    !/^[a-f0-9]{64}$/.test(context.policyDigest)
  ) {
    throw new DeliveryError('invalid-decoder-admission-context');
  }
  return path.join(context.registryRoot, context.producerRevision);
}

export function readApprovedEvidenceDecoder(
  context: EvidenceDecoderContext,
): ApprovedEvidenceDecoder | undefined {
  const directory = descriptorDirectory(context);
  const file = path.join(directory, 'approved.json');
  if (!existsSync(file)) {
    return undefined;
  }
  try {
    const value = regularJson(file, true);
    if (
      !object(value) ||
      Object.keys(value).length !== 7 ||
      value.version !== 1 ||
      value.producerRevision !== context.producerRevision ||
      value.policyDigest !== context.policyDigest ||
      typeof value.reviewCandidate !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.reviewCandidate) ||
      typeof value.decoderDigest !== 'string' ||
      typeof value.fixtureSetDigest !== 'string' ||
      !object(value.independentReview)
    ) {
      throw new DeliveryError('invalid-approved-decoder-descriptor');
    }
    const descriptor = value as unknown as ApprovedEvidenceDecoder;
    const fixtures = parseFixtures(regularJson(path.join(directory, 'fixtures.json'), true));
    if (
      fileSha256(path.join(directory, 'decoder.mjs')) !== descriptor.decoderDigest ||
      evidenceDecoderFixtureDigest(fixtures) !== descriptor.fixtureSetDigest
    ) {
      throw new DeliveryError('approved-decoder-bytes-changed');
    }
    admitReview(
      descriptor.independentReview,
      descriptor.reviewCandidate,
      evidenceDecoderAcceptance(
        descriptor.decoderDigest,
        descriptor.fixtureSetDigest,
        context.policyDigest,
      ),
    );
    return descriptor;
  } catch (error) {
    if (error instanceof DeliveryError) {
      throw error;
    }
    throw new DeliveryError('invalid-approved-decoder-descriptor');
  }
}

export async function adoptReviewedEvidenceDecoder(
  options: AdoptEvidenceDecoderOptions,
  executor?: EvidenceDecoderExecutor,
): Promise<ApprovedEvidenceDecoder> {
  const directory = descriptorDirectory(options);
  if (!/^[a-f0-9]{64}$/.test(options.reviewCandidate)) {
    throw new DeliveryError('invalid-decoder-review-candidate');
  }
  const proposed: ApprovedEvidenceDecoder = {
    version: 1,
    producerRevision: options.producerRevision,
    reviewCandidate: options.reviewCandidate,
    policyDigest: options.policyDigest,
    decoderDigest: options.proposal.decoderDigest,
    fixtureSetDigest: options.proposal.fixtureSetDigest,
    independentReview: options.independentReview,
  };
  const existing = readApprovedEvidenceDecoder(options);
  if (existing !== undefined) {
    if (digest(existing) !== digest(proposed)) {
      throw new DeliveryError('decoder-admission-already-frozen');
    }
    return existing;
  }
  const valid = options.proposal.fixtures.find((fixture) => fixture.name === 'valid');
  if (valid === undefined) {
    throw new DeliveryError('decoder-positive-fixture-missing');
  }
  const scratchRoot = path.join(options.registryRoot, '.scratch');
  await runReviewedEvidenceDecoder(
    {
      ...options.proposal,
      independentReview: options.independentReview,
      candidate: options.reviewCandidate,
      policyDigest: options.policyDigest,
      input: valid.input,
      scratchRoot,
      timeoutMs: options.timeoutMs,
      execution: options.execution,
      validateProjection: (input, projection) => {
        withPlanningArtifactProjection(input, projection, scratchRoot, () => undefined);
      },
    },
    executor,
  );
  mkdirSync(options.registryRoot, { recursive: true, mode: 0o700 });
  const staged = mkdtempSync(path.join(options.registryRoot, '.adoption-'));
  try {
    writeFileSync(path.join(staged, 'decoder.mjs'), readFileSync(options.proposal.decoderFile), {
      mode: 0o400,
      flag: 'wx',
    });
    if (fileSha256(path.join(staged, 'decoder.mjs')) !== proposed.decoderDigest) {
      throw new DeliveryError('reviewed-decoder-bytes-changed');
    }
    writeFileSync(path.join(staged, 'fixtures.json'), JSON.stringify(options.proposal.fixtures), {
      mode: 0o400,
      flag: 'wx',
    });
    writeFileSync(path.join(staged, 'approved.json'), JSON.stringify(proposed), {
      mode: 0o400,
      flag: 'wx',
    });
    renameSync(staged, directory);
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  return proposed;
}

export async function decodeApprovedPlanningArtifacts(
  context: EvidenceDecoderContext,
  input: string,
  execution: ExecutionControl,
  validate?: (workDir: string, stateDir: string) => void,
  executor?: EvidenceDecoderExecutor,
): Promise<ReviewedEvidenceDecoderResult> {
  const descriptor = readApprovedEvidenceDecoder(context);
  if (descriptor === undefined) {
    throw new DeliveryError('evidence-decoder-not-approved');
  }
  const directory = descriptorDirectory(context);
  const scratchRoot = path.join(context.registryRoot, '.scratch');
  const validateProjection = (bundle: string, projection: PlanningArtifactProjection) => {
    withPlanningArtifactProjection(bundle, projection, scratchRoot, (workDir, stateDir) => {
      if (bundle === input) {
        validate?.(workDir, stateDir);
      }
    });
  };
  return runReviewedEvidenceDecoder(
    {
      decoderFile: path.join(directory, 'decoder.mjs'),
      decoderDigest: descriptor.decoderDigest,
      fixtures: parseFixtures(regularJson(path.join(directory, 'fixtures.json'), true)),
      fixtureSetDigest: descriptor.fixtureSetDigest,
      independentReview: descriptor.independentReview,
      candidate: descriptor.reviewCandidate,
      policyDigest: descriptor.policyDigest,
      input,
      scratchRoot,
      timeoutMs: context.timeoutMs,
      execution,
      validateProjection,
    },
    executor,
  );
}

export function planningDecoderContext(
  mandate: Mandate,
  stateDirectory: string,
  producerRevision: string,
): EvidenceDecoderContext {
  return {
    registryRoot: path.join(stateDirectory, 'evidence-decoders'),
    producerRevision,
    policyDigest: mandate.controllerDigest,
    timeoutMs: Math.min(60_000, mandate.profile.bounds.commandTimeoutMs),
  };
}
