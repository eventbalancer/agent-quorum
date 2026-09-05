import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { contentDigest, digest } from '../../src/delivery/contract.js';
import {
  DECODER_NEGATIVE_CASES,
  type CanonicalPlanEvidence,
  type ReviewReceipt,
} from '../../src/delivery/evidence.js';
import {
  evidenceDecoderAcceptance,
  evidenceDecoderFixtureDigest,
  evidenceDecoderSandbox,
  runReviewedEvidenceDecoder,
  type ReviewedEvidenceDecoderOptions,
} from '../../src/delivery/evidence-decoder.js';
import { runDeliveryCommand, type CommandInput } from '../../src/delivery/commands.js';

const directories: string[] = [];
afterEach(() => {
  for (const root of directories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function options(): ReviewedEvidenceDecoderOptions {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delivery-decoder-'));
  directories.push(root);
  const decoderFile = path.join(root, 'proposed.mjs');
  const program = `import { readFileSync } from 'node:fs';
const request = JSON.parse(readFileSync(0, 'utf8'));
const admitted = request.input === 'valid' || request.input === 'actual';
const evidence = { version: 1, candidate: request.candidate, artifactDigest: request.artifactDigest, schemaVersions: [4,3,2], ready: true, exactBindings: true, requiredSourcesPresent: true, aggregateConsistent: true, judgeSatisfied: true };
process.stdout.write(JSON.stringify(admitted ? { admitted, evidence, projection: { files: { 'input.md': 'Input', 'run/plan.final.md': 'Plan' } } } : { admitted }));`;
  writeFileSync(decoderFile, program);
  const decoderDigest = contentDigest(program);
  const fixtures = ['valid', ...DECODER_NEGATIVE_CASES].map((name) => ({ name, input: name }));
  const fixtureSetDigest = evidenceDecoderFixtureDigest(fixtures);
  const policyDigest = 'b'.repeat(64);
  const candidate = 'c'.repeat(64);
  const acceptance = evidenceDecoderAcceptance(decoderDigest, fixtureSetDigest, policyDigest);
  const independentReview: ReviewReceipt = {
    invocationId: 'independent-review',
    implementationInvocationId: 'adapter-implementation',
    candidate,
    acceptanceDigest: digest(acceptance),
    approved: true,
    findings: [],
    acceptanceEvidence: acceptance.map((criterion) => ({
      ...criterion,
      evidence: [`Reviewed ${criterion.id} at exact code and fixture digests`],
    })),
    adjacentFindings: [],
    liveReuseApproved: false,
    interveningDiffDigest: '',
  };
  return {
    decoderFile,
    decoderDigest,
    fixtures,
    fixtureSetDigest,
    independentReview,
    candidate,
    policyDigest,
    input: 'actual',
    scratchRoot: path.join(root, 'scratch'),
    timeoutMs: 10_000,
    execution: {
      deadlineEpochMs: Date.now() + 30_000,
      env: { GITHUB_TOKEN: 'must-not-propagate' },
    },
  };
}

function execution(
  request: CommandInput,
  mutate?: (
    input: string,
    evidence: CanonicalPlanEvidence,
  ) => { admitted: boolean; evidence?: CanonicalPlanEvidence },
): { exitCode: number; stdout: string; stderr: string } {
  const parsed = JSON.parse(request.input ?? '') as {
    candidate: string;
    artifactDigest: string;
    input: string;
  };
  const evidence: CanonicalPlanEvidence = {
    version: 1,
    candidate: parsed.candidate,
    artifactDigest: parsed.artifactDigest,
    schemaVersions: [4, 3, 2],
    ready: true,
    exactBindings: true,
    requiredSourcesPresent: true,
    aggregateConsistent: true,
    judgeSatisfied: true,
  };
  const admitted = parsed.input === 'valid' || parsed.input === 'actual';
  const output =
    mutate?.(parsed.input, evidence) ?? (admitted ? { admitted, evidence } : { admitted });
  return {
    exitCode: 0,
    stdout: JSON.stringify(
      output.admitted
        ? { ...output, projection: { files: { 'input.md': 'Input', 'run/plan.final.md': 'Plan' } } }
        : output,
    ),
    stderr: '',
  };
}

describe('reviewed evidence decoder execution', () => {
  it('executes positive, every negative and actual artifacts with copied reviewed bytes in a bounded credential-free sandbox', async () => {
    const settings = options();
    const calls: CommandInput[] = [];
    const result = await runReviewedEvidenceDecoder(settings, {
      run: (request) => {
        calls.push(request);
        expect(request.command).toBe('/usr/bin/sandbox-exec');
        expect(request.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C', HOME: request.cwd });
        expect(request.execution.env).toEqual(request.env);
        expect(request.execution.deadlineEpochMs).toBeLessThanOrEqual(
          Date.now() + settings.timeoutMs,
        );
        expect(contentDigest(readFileSync(request.args[3] ?? ''))).toBe(settings.decoderDigest);
        return Promise.resolve(execution(request));
      },
    });
    expect(calls).toHaveLength(10);
    expect(result.artifactDigest).toBe(contentDigest('actual'));
    expect(result.admission.conformance.map((entry) => entry.name)).toEqual([
      'valid',
      ...DECODER_NEGATIVE_CASES,
    ]);
    expect(
      result.admission.conformance.every((entry) => /^[a-f0-9]{64}$/.test(entry.outputDigest)),
    ).toBe(true);
    const policy = evidenceDecoderSandbox(settings.decoderFile);
    expect(policy).toContain('(deny default)');
    expect(policy).not.toContain('network-outbound');
    expect(policy).not.toContain('process-fork');
  });

  it('rejects missing conformance inputs and changed code before executing anything', async () => {
    const settings = options();
    let calls = 0;
    const executor = {
      run: (input: CommandInput) => {
        calls += 1;
        return Promise.resolve(execution(input));
      },
    };
    await expect(
      runReviewedEvidenceDecoder({ ...settings, fixtures: settings.fixtures.slice(1) }, executor),
    ).rejects.toThrow('invalid-decoder-conformance-bundle');
    writeFileSync(settings.decoderFile, 'changed');
    await expect(runReviewedEvidenceDecoder(settings, executor)).rejects.toThrow(
      'reviewed-decoder-bytes-changed',
    );
    expect(calls).toBe(0);
  });

  it('rejects a worker-authored review and insufficient fixture review evidence', async () => {
    const settings = options();
    const executor = { run: (input: CommandInput) => Promise.resolve(execution(input)) };
    await expect(
      runReviewedEvidenceDecoder(
        {
          ...settings,
          independentReview: {
            ...settings.independentReview,
            invocationId: settings.independentReview.implementationInvocationId,
          },
        },
        executor,
      ),
    ).rejects.toThrow('stale-or-nonindependent-review');
    await expect(
      runReviewedEvidenceDecoder(
        {
          ...settings,
          independentReview: {
            ...settings.independentReview,
            acceptanceEvidence: settings.independentReview.acceptanceEvidence.slice(0, 1),
          },
        },
        executor,
      ),
    ).rejects.toThrow('acceptance-evidence-incomplete');
  });

  it.each(DECODER_NEGATIVE_CASES)(
    'rejects an adapter that admits the %s case',
    async (negative) => {
      const settings = options();
      await expect(
        runReviewedEvidenceDecoder(settings, {
          run: (request) =>
            Promise.resolve(
              execution(request, (input, evidence) =>
                input === 'valid' || input === 'actual' || input === negative
                  ? { admitted: true, evidence }
                  : { admitted: false },
              ),
            ),
        }),
      ).rejects.toThrow('decoder-conformance-failed');
    },
  );

  it('never turns crashed negative cases into conformance success and rejects stale actual bindings', async () => {
    const settings = options();
    await expect(
      runReviewedEvidenceDecoder(settings, {
        run: () => Promise.resolve({ exitCode: 1, stdout: '{"admitted":false}', stderr: '' }),
      }),
    ).rejects.toThrow('decoder-execution-failed');
    await expect(
      runReviewedEvidenceDecoder(settings, {
        run: (request) =>
          Promise.resolve(
            execution(request, (input, evidence) =>
              input === 'valid'
                ? { admitted: true, evidence }
                : input === 'actual'
                  ? { admitted: true, evidence: { ...evidence, artifactDigest: 'a'.repeat(64) } }
                  : { admitted: false },
            ),
          ),
      }),
    ).rejects.toThrow('unadmitted-canonical-plan-evidence');
  });

  it.skipIf(process.platform !== 'darwin')(
    'executes actual local decoder processes under the sandbox without any provider invocation',
    async () => {
      const result = await runReviewedEvidenceDecoder(options(), {
        run: async (input) => {
          const result = await runDeliveryCommand(input);
          expect(result.exitCode, result.stderr).toBe(0);
          return result;
        },
      });
      expect(result.admission.conformance).toHaveLength(9);
      expect(result.evidence.artifactDigest).toBe(contentDigest('actual'));
    },
  );
  it.skipIf(process.platform !== 'darwin')(
    'denies actual decoder reads, writes and descendant execution outside its copied program',
    async () => {
      const settings = options();
      const secretFile = path.join(path.dirname(settings.decoderFile), 'controller-secret');
      const outputFile = path.join(path.dirname(settings.decoderFile), 'unauthorized-write');
      writeFileSync(secretFile, 'private fixture secret');
      const prefix = `import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
let escaped = false;
try { readFileSync(${JSON.stringify(secretFile)}, 'utf8'); escaped = true; } catch {}
try { writeFileSync(${JSON.stringify(outputFile)}, 'unauthorized'); escaped = true; } catch {}
if (spawnSync(process.execPath, ['-e', 'process.exit(0)']).error === undefined) escaped = true;
if (escaped || process.env.GITHUB_TOKEN !== undefined) process.exit(71);
`;
      const program = prefix + readFileSync(settings.decoderFile, 'utf8');
      writeFileSync(settings.decoderFile, program);
      const decoderDigest = contentDigest(program);
      const acceptance = evidenceDecoderAcceptance(
        decoderDigest,
        settings.fixtureSetDigest,
        settings.policyDigest,
      );
      const reviewed = {
        ...settings,
        decoderDigest,
        independentReview: {
          ...settings.independentReview,
          acceptanceDigest: digest(acceptance),
          acceptanceEvidence: acceptance.map((criterion) => ({
            ...criterion,
            evidence: ['Reviewed exact sandbox denial fixture'],
          })),
        },
      };
      const admitted = await runReviewedEvidenceDecoder(reviewed);
      expect(admitted.evidence.ready).toBe(true);
      expect(existsSync(outputFile)).toBe(false);
      expect(readFileSync(secretFile, 'utf8')).toBe('private fixture secret');
    },
  );
});
