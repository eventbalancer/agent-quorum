import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { runDeliveryCommand, type CommandInput, type CommandResult } from './commands.js';
import { contentDigest, DeliveryError, digest, type AcceptanceCriterion } from './contract.js';
import {
  admitCanonicalPlan,
  admitDecoder,
  admitReview,
  DECODER_NEGATIVE_CASES,
  type CanonicalPlanEvidence,
  type DecoderAdmission,
  type DecoderCaseReceipt,
  type ReviewReceipt,
} from './evidence.js';
import {
  parsePlanningArtifactProjection,
  type PlanningArtifactProjection,
} from './evidence-artifacts.js';
import type { ExecutionControl } from '../runtime/execution-control.js';

export interface EvidenceDecoderFixture {
  readonly name: string;
  readonly input: string;
}

export interface ReviewedEvidenceDecoderOptions {
  readonly decoderFile: string;
  readonly decoderDigest: string;
  readonly fixtures: readonly EvidenceDecoderFixture[];
  readonly fixtureSetDigest: string;
  readonly independentReview: ReviewReceipt;
  readonly candidate: string;
  readonly policyDigest: string;
  readonly input: string;
  readonly scratchRoot: string;
  readonly timeoutMs: number;
  readonly execution: ExecutionControl;
  readonly validateProjection?: (input: string, projection: PlanningArtifactProjection) => void;
}

export interface ReviewedEvidenceDecoderResult {
  readonly evidence: CanonicalPlanEvidence;
  readonly admission: DecoderAdmission;
  readonly artifactDigest: string;
  readonly executionOutputDigest: string;
  readonly projection: PlanningArtifactProjection;
}

export interface EvidenceDecoderExecutor {
  readonly run: (input: CommandInput) => Promise<CommandResult>;
}

interface DecoderOutput {
  readonly admitted: boolean;
  readonly evidence?: CanonicalPlanEvidence;
  readonly projection?: PlanningArtifactProjection;
}

const MAX_DECODER_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export function evidenceDecoderAcceptance(
  decoderDigest: string,
  fixtureSetDigest: string,
  policyDigest: string,
): readonly AcceptanceCriterion[] {
  return [
    {
      id: 'DECODER-1',
      outcome: `Decoder ${decoderDigest} faithfully maps current artifacts without weakening policy ${policyDigest} or expanding authority.`,
      evidence: [],
    },
    {
      id: 'DECODER-2',
      outcome: `Fixture bundle ${fixtureSetDigest} contains valid current-schema evidence and authentic instances of every required negative assurance case.`,
      evidence: [],
    },
    {
      id: 'DECODER-3',
      outcome:
        'Live evidence projection preserves the actual provider call set, source and candidate prompts, and response meaning, including every negative provider verdict. Only schema representation may change; a failed or absent provider assessment must never become satisfied evidence.',
      evidence: [],
    },
  ];
}

export function evidenceDecoderFixtureDigest(fixtures: readonly EvidenceDecoderFixture[]): string {
  return digest(
    [...fixtures]
      .sort((left, right) => left.name.localeCompare(right.name))
      .map((fixture) => ({ name: fixture.name, inputDigest: contentDigest(fixture.input) })),
  );
}

export function evidenceDecoderSandbox(decoderFile: string): string {
  const quote = (value: string) => JSON.stringify(realpathSync(path.resolve(value)));
  return [
    '(version 1)',
    '(deny default)',
    '(allow file-read-metadata)',
    '(allow file-read-data (literal "/"))',
    '(allow sysctl-read)',
    '(allow mach-lookup)',
    `(allow process-exec (literal ${quote(process.execPath)}))`,
    '(allow signal (target self))',
    `(allow file-read* (literal ${quote(decoderFile)}) (subpath ${quote(path.dirname(process.execPath))}) (subpath "/System/Library") (subpath "/usr/lib") (subpath "/private/var/db/dyld") (subpath "/usr/share/zoneinfo") (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))`,
    '(allow file-write* (literal "/dev/null"))',
  ].join('\n');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEnvelope(value: unknown): CanonicalPlanEvidence {
  const keys = [
    'version',
    'candidate',
    'artifactDigest',
    'schemaVersions',
    'ready',
    'exactBindings',
    'requiredSourcesPresent',
    'aggregateConsistent',
    'judgeSatisfied',
  ];
  if (
    !isObject(value) ||
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key)) ||
    value.version !== 1 ||
    typeof value.candidate !== 'string' ||
    typeof value.artifactDigest !== 'string' ||
    !Array.isArray(value.schemaVersions) ||
    !value.schemaVersions.every(
      (version: unknown) =>
        typeof version === 'number' && Number.isSafeInteger(version) && version > 0,
    ) ||
    typeof value.ready !== 'boolean' ||
    typeof value.exactBindings !== 'boolean' ||
    typeof value.requiredSourcesPresent !== 'boolean' ||
    typeof value.aggregateConsistent !== 'boolean' ||
    typeof value.judgeSatisfied !== 'boolean'
  ) {
    throw new DeliveryError('invalid-decoder-envelope');
  }
  return {
    version: 1,
    candidate: value.candidate,
    artifactDigest: value.artifactDigest,
    schemaVersions: value.schemaVersions as number[],
    ready: value.ready,
    exactBindings: value.exactBindings,
    requiredSourcesPresent: value.requiredSourcesPresent,
    aggregateConsistent: value.aggregateConsistent,
    judgeSatisfied: value.judgeSatisfied,
  };
}

function parseOutput(stdout: string): DecoderOutput {
  if (Buffer.byteLength(stdout) > MAX_OUTPUT_BYTES) {
    throw new DeliveryError('decoder-output-limit');
  }
  const value: unknown = JSON.parse(stdout);
  if (
    !isObject(value) ||
    typeof value.admitted !== 'boolean' ||
    Object.keys(value).some(
      (key) => key !== 'admitted' && key !== 'evidence' && key !== 'projection',
    )
  ) {
    throw new DeliveryError('invalid-decoder-result');
  }
  if (!value.admitted) {
    if (value.evidence !== undefined || value.projection !== undefined) {
      throw new DeliveryError('rejected-decoder-result-carries-evidence');
    }
    return { admitted: false };
  }
  return {
    admitted: true,
    evidence: parseEnvelope(value.evidence),
    projection: parsePlanningArtifactProjection(value.projection),
  };
}

function assertFixtures(options: ReviewedEvidenceDecoderOptions): void {
  const names = ['valid', ...DECODER_NEGATIVE_CASES];
  if (
    options.fixtures.length !== names.length ||
    names.some(
      (name) => options.fixtures.filter((fixture) => fixture.name === name).length !== 1,
    ) ||
    options.fixtures.some((fixture) => Buffer.byteLength(fixture.input) > MAX_INPUT_BYTES) ||
    new Set(options.fixtures.map((fixture) => contentDigest(fixture.input))).size !==
      names.length ||
    evidenceDecoderFixtureDigest(options.fixtures) !== options.fixtureSetDigest
  ) {
    throw new DeliveryError('invalid-decoder-conformance-bundle');
  }
}

export async function runReviewedEvidenceDecoder(
  options: ReviewedEvidenceDecoderOptions,
  executor: EvidenceDecoderExecutor = { run: runDeliveryCommand },
): Promise<ReviewedEvidenceDecoderResult> {
  if (
    !Number.isSafeInteger(options.timeoutMs) ||
    options.timeoutMs <= 0 ||
    options.timeoutMs > 120 * 60_000 ||
    Buffer.byteLength(options.input) > MAX_INPUT_BYTES
  ) {
    throw new DeliveryError('invalid-decoder-execution-bound');
  }
  assertFixtures(options);
  const acceptance = evidenceDecoderAcceptance(
    options.decoderDigest,
    options.fixtureSetDigest,
    options.policyDigest,
  );
  admitReview(options.independentReview, options.candidate, acceptance);
  const metadata = lstatSync(options.decoderFile);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_DECODER_BYTES) {
    throw new DeliveryError('invalid-reviewed-decoder-file');
  }
  const program = readFileSync(options.decoderFile);
  if (contentDigest(program) !== options.decoderDigest) {
    throw new DeliveryError('reviewed-decoder-bytes-changed');
  }
  mkdirSync(options.scratchRoot, { recursive: true, mode: 0o700 });
  const scratch = mkdtempSync(path.join(options.scratchRoot, 'decoder-'));
  const decoderFile = path.join(scratch, 'decoder.mjs');
  const policyFile = path.join(scratch, 'sandbox.sb');
  writeFileSync(decoderFile, program, { mode: 0o400, flag: 'wx' });
  writeFileSync(policyFile, evidenceDecoderSandbox(decoderFile), { mode: 0o400, flag: 'wx' });
  const environment: NodeJS.ProcessEnv = { PATH: '/usr/bin:/bin', LANG: 'C', HOME: scratch };
  const started = Date.now();
  const deadline = Math.min(
    started + options.timeoutMs,
    options.execution.deadlineEpochMs ?? Number.MAX_SAFE_INTEGER,
  );
  const execution: ExecutionControl = {
    ...options.execution,
    env: environment,
    deadlineEpochMs: deadline,
  };
  const run = async (
    input: string,
  ): Promise<{ readonly output: DecoderOutput; readonly outputDigest: string }> => {
    const artifactDigest = contentDigest(input);
    const request = { candidate: options.candidate, artifactDigest, input };
    const result = await executor.run({
      command: '/usr/bin/sandbox-exec',
      args: ['-f', policyFile, process.execPath, decoderFile],
      cwd: scratch,
      execution,
      env: environment,
      input: JSON.stringify(request),
    });
    if (result.exitCode !== 0) {
      throw new DeliveryError('decoder-execution-failed');
    }
    const output = parseOutput(result.stdout);
    if (output.admitted) {
      if (output.evidence === undefined) {
        throw new DeliveryError('decoder-evidence-missing');
      }
      admitCanonicalPlan(output.evidence, options.candidate, artifactDigest);
      if (output.projection === undefined) {
        throw new DeliveryError('decoder-projection-missing');
      }
      options.validateProjection?.(input, output.projection);
    }
    return { output, outputDigest: contentDigest(result.stdout) };
  };
  try {
    const conformance: DecoderCaseReceipt[] = [];
    for (const fixture of options.fixtures) {
      const result = await run(fixture.input);
      if (result.output.admitted !== (fixture.name === 'valid')) {
        throw new DeliveryError('decoder-conformance-failed');
      }
      conformance.push({
        name: fixture.name,
        inputDigest: contentDigest(fixture.input),
        outputDigest: result.outputDigest,
        admitted: result.output.admitted,
      });
    }
    const admission: DecoderAdmission = {
      decoderDigest: options.decoderDigest,
      candidate: options.candidate,
      policyDigest: options.policyDigest,
      fixtureSetDigest: options.fixtureSetDigest,
      independentReview: options.independentReview,
      conformance,
    };
    admitDecoder(admission, options.candidate, options.policyDigest);
    const actual = await run(options.input);
    if (
      !actual.output.admitted ||
      actual.output.evidence === undefined ||
      actual.output.projection === undefined
    ) {
      throw new DeliveryError('current-artifact-decoder-rejected');
    }
    return {
      evidence: actual.output.evidence,
      projection: actual.output.projection,
      admission,
      artifactDigest: contentDigest(options.input),
      executionOutputDigest: actual.outputDigest,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
