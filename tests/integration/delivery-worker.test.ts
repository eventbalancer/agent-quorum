import { mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as registry from '../../src/providers/registry.js';
import { CodexDeliveryWorker } from '../../src/delivery/worker.js';
import { deliveryMandate } from '../helpers/delivery.js';
import { argvRecords, REPO_ROOT, withEnvAsync, writeFakeBin } from '../helpers/harness.js';
import { fixtureMatrix } from '../helpers/test-context.js';

let root: string;
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'delivery-worker-contract-'));
  writeFakeBin(path.join(root, 'bin'));
  renameSync(path.join(root, 'bin/codex'), path.join(root, 'bin/codex-fixture'));
  vi.spyOn(registry, 'resolveRunnerBinaries').mockReturnValue({
    codex: path.join(root, 'bin/codex'),
    claude: path.join(root, 'bin/claude'),
    cursor: path.join(root, 'bin/cursor-agent'),
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function worker(): CodexDeliveryWorker {
  const mandate = deliveryMandate(root);
  const configFile = path.join(root, 'config.json');
  writeFileSync(configFile, JSON.stringify({ version: 1, roles: fixtureMatrix() }));
  return new CodexDeliveryWorker({
    ...mandate,
    runtimeRoot: REPO_ROOT,
    mcpServerNames: ['fixture-server'],
    profile: { ...mandate.profile, planning: { ...mandate.profile.planning, configFile } },
  });
}

function responseFile(value: unknown, name = 'response.json'): string {
  const file = path.join(root, name);
  writeFileSync(file, JSON.stringify(value));
  return file;
}

function fixtureProvider(env: NodeJS.ProcessEnv): void {
  writeFileSync(
    path.join(root, 'bin/codex'),
    '#!' +
      process.execPath +
      '\n' +
      `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path.join(root, 'inherited.json'))},JSON.stringify(process.env));const result=require('node:child_process').spawnSync('/bin/bash',[${JSON.stringify(path.join(root, 'bin/codex-fixture'))},...process.argv.slice(2)],{stdio:'inherit',env:{...process.env,...${JSON.stringify(env)}}});process.exit(result.status??1);`,
    { mode: 0o700 },
  );
}

const valid = {
  action: 'ready',
  acceptance: [{ id: 'AC-1', outcome: 'Preserve current behavior', evidence: ['fixture.ts:1'] }],
  decisions: ['Use the existing contract'],
  dependencies: [],
  findings: [],
  requiresPlan: false,
  rationale: 'The observed behavior is implemented.',
  relatedIssue: null,
  edits: [],
  targetedTests: [],
  packageOperations: [],
  uncertainty: '',
};

describe('delivery worker provider boundary', () => {
  it('runs implementation and independent review as distinct fresh read-only invocations', async () => {
    const argvLog = path.join(root, 'argv');
    const workOutput = responseFile(valid);
    const reviewOutput = responseFile(
      {
        approved: true,
        findings: [],
        acceptanceEvidence: valid.acceptance,
        adjacentFindings: [],
        liveReuseApproved: false,
        interveningDiffDigest: '',
      },
      'review.json',
    );
    let starts = 0;
    const service = worker();
    fixtureProvider({
      FAKE_CODEX_PROMPT: path.join(root, 'prompt'),
      FAKE_CODEX_ARGV_LOG: argvLog,
      FAKE_CODEX_OUTPUT_CALLS: path.join(root, 'calls'),
      FAKE_CODEX_OUTPUT_1: workOutput,
      FAKE_CODEX_OUTPUT_2: reviewOutput,
    });
    await withEnvAsync(
      {
        GH_TOKEN: 'secret',
        GITHUB_TOKEN: 'secret',
        AGENT_QUORUM_EXECUTION_CONTROL_FILE: '/guardian-secret',
        PRIVATE_SENTINEL: 'secret',
        PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
        FAKE_CODEX_PROMPT: path.join(root, 'prompt'),
        FAKE_CODEX_ARGV_LOG: argvLog,
        FAKE_CODEX_OUTPUT_CALLS: path.join(root, 'calls'),
        FAKE_CODEX_OUTPUT_1: workOutput,
        FAKE_CODEX_OUTPUT_2: reviewOutput,
      },
      async () => {
        const execution = {
          deadlineEpochMs: Date.now() + 10000,
          beforeSpawn: () => {
            starts += 1;
          },
        };
        const implementation = await service.work({
          issue: 1,
          cwd: root,
          prompt: 'Verify this fixture.',
          outputFile: path.join(root, 'implemented.json'),
          execution,
        });
        const review = await service.review({
          issue: 1,
          cwd: root,
          prompt: 'Review the actual fixture diff.',
          outputFile: path.join(root, 'reviewed.json'),
          execution,
        });
        expect(implementation.result).toEqual(valid);
        expect(review.result.approved).toBe(true);
        expect(review.invocationId).not.toBe(implementation.invocationId);
      },
    );
    expect(starts).toBe(2);
    const inherited = JSON.parse(
      readFileSync(path.join(root, 'inherited.json'), 'utf8'),
    ) as NodeJS.ProcessEnv;
    for (const key of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'AGENT_QUORUM_EXECUTION_CONTROL_FILE',
      'PRIVATE_SENTINEL',
    ]) {
      expect(inherited[key]).toBeUndefined();
    }
    for (const argv of argvRecords(argvLog)) {
      expect(argv).toContain('--ignore-user-config');
      expect(argv.join(' ')).toContain('agent-quorum-delivery');
      expect(argv.join(' ')).toContain('fixture-server');
      expect(argv).not.toContain('resume');
    }
    expect(readFileSync(path.join(root, 'prompt'), 'utf8')).toContain('actual fixture diff');
  });

  it('rejects schema-invalid results and admits every actual bounded retry', async () => {
    let starts = 0;
    const service = worker();
    fixtureProvider({
      FAKE_CODEX_PROMPT: path.join(root, 'prompt'),
      FAKE_CODEX_OUTPUT: responseFile({ action: 'ready' }),
    });
    await withEnvAsync(
      {
        PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
        FAKE_CODEX_PROMPT: path.join(root, 'prompt'),
        FAKE_CODEX_OUTPUT: responseFile({ action: 'ready' }),
      },
      async () => {
        await expect(
          service.work({
            issue: 1,
            cwd: root,
            prompt: 'Invalid fixture',
            outputFile: path.join(root, 'invalid.json'),
            execution: {
              deadlineEpochMs: Date.now() + 5000,
              beforeSpawn: () => {
                starts += 1;
              },
            },
          }),
        ).rejects.toThrow('delivery-provider-failed');
      },
    );
    expect(starts).toBe(2);
  });
});
