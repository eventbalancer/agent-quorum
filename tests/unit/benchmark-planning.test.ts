import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assignmentFor,
  BENCHMARK_ROOT,
  benchmarkChildEnvironment,
  createBlindBundle,
  DEFAULT_MANIFEST_FILE,
  loadPlanningBenchmark,
  scorePlanningBenchmark,
  validatePlanningBenchmark,
  verifyBenchmarkOutputLocation,
  verifyBenchmarkWorkspace,
} from '../../scripts/benchmark-planning/benchmark.js';
import type {
  BenchmarkRunResults,
  BenchmarkTaskRunResult,
  BlindAnswerKey,
  BlindMaterialFinding,
  BlindLabel,
  BlindPreference,
  BlindReview,
  PlanningBenchmarkManifest,
} from '../../scripts/benchmark-planning/model.js';

interface ResultsFixtureOptions {
  readonly standardReady?: number;
  readonly highReady?: number;
}

interface ReviewFixtureOptions {
  readonly preference: (taskIndex: number, key: BlindAnswerKey) => BlindPreference;
  readonly findings?: (taskIndex: number, key: BlindAnswerKey) => readonly BlindMaterialFinding[];
  readonly knownConcernDisposition?: (
    taskIndex: number,
    plan: BlindLabel,
    knownConcernId: string,
    key: BlindAnswerKey,
  ) => 'addressed' | 'missed' | 'unreviewed';
}

let temporaryRoot: string;

beforeEach(() => {
  temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-planning-benchmark.'));
});

afterEach(() => {
  rmSync(temporaryRoot, { recursive: true, force: true });
});

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function git(root: string, args: readonly string[]): string {
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(' ')} failed`);
  }
  return result.stdout.trim();
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function fixtureResults(
  manifest: PlanningBenchmarkManifest,
  options: ResultsFixtureOptions = {},
): string {
  const resultsRoot = path.join(temporaryRoot, 'results');
  mkdirSync(resultsRoot, { recursive: true });
  const standardReady = options.standardReady ?? 4;
  const highReady = options.highReady ?? 4;
  let standardIndex = 0;
  let highIndex = 0;
  const tasks: BenchmarkTaskRunResult[] = manifest.tasks.map((task) => {
    const taskRoot = path.join(resultsRoot, task.id);
    mkdirSync(taskRoot, { recursive: true });
    const candidatePlan = path.join(task.id, 'plan.final.md');
    const candidateText = `---\nstatus: clean\nphase_count: 1\n---\n\n# Plan ${task.id}\n\nImplementation-ready fixture.\n`;
    writeFileSync(path.join(resultsRoot, candidatePlan), candidateText);
    const isReady =
      task.risk === 'standard' ? standardIndex++ < standardReady : highIndex++ < highReady;
    const critiqueIterations = task.risk === 'standard' ? (isReady ? 2 : 3) : isReady ? 3 : 4;
    return {
      taskId: task.id,
      decision: isReady ? 'ready' : 'revision-required',
      critiqueIterations,
      exitCode: 0,
      candidatePlan,
      candidateSha256: sha256(candidateText),
    };
  });
  const providerConfigText = readFileSync(
    path.join(BENCHMARK_ROOT, manifest.tasks[0]?.providerConfig ?? ''),
    'utf8',
  );
  const results: BenchmarkRunResults = {
    schemaVersion: 1,
    suiteId: manifest.suiteId,
    workspaceRevision: manifest.tasks[0]?.workspaceRevision ?? '',
    providerConfigSha256: sha256(providerConfigText),
    tasks,
  };
  const resultsFile = path.join(resultsRoot, 'run-results.json');
  writeJson(resultsFile, results);
  return resultsFile;
}

function blindFixture(
  manifest: PlanningBenchmarkManifest,
  resultsFile: string,
  suffix = '',
): { readonly key: BlindAnswerKey; readonly keyFile: string; readonly bundleDir: string } {
  const bundleDir = path.join(temporaryRoot, `bundle${suffix}`);
  const keyFile = path.join(temporaryRoot, `key${suffix}.json`);
  const key = createBlindBundle({
    resultsFile,
    outputDir: bundleDir,
    keyFile,
    seed: 'stable-seed',
  });
  expect(key.assignments).toHaveLength(manifest.tasks.length);
  return { key, keyFile, bundleDir };
}

function reviewFixture(
  manifest: PlanningBenchmarkManifest,
  key: BlindAnswerKey,
  reviewerId: string,
  options: ReviewFixtureOptions,
): string {
  const review: BlindReview = {
    schemaVersion: 1,
    suiteId: manifest.suiteId,
    reviewerId,
    tasks: manifest.tasks.map((task, taskIndex) => {
      const findings = options.findings?.(taskIndex, key) ?? [];
      return {
        taskId: task.id,
        preference: options.preference(taskIndex, key),
        findings,
        knownConcernAssessments: task.knownConcerns.flatMap((concern) =>
          (['A', 'B'] as const).map((plan) => ({
            plan,
            knownConcernId: concern.id,
            disposition:
              options.knownConcernDisposition?.(taskIndex, plan, concern.id, key) ??
              (findings.some(
                (finding) => finding.plan === plan && finding.knownConcernId === concern.id,
              )
                ? 'missed'
                : 'addressed'),
            evidence: `${plan} fixture adjudication for ${concern.id}`,
          })),
        ),
      };
    }),
  };
  const reviewFile = path.join(temporaryRoot, `${reviewerId}.json`);
  writeJson(reviewFile, review);
  return reviewFile;
}

function assignment(key: BlindAnswerKey, taskIndex: number) {
  const selected = key.assignments[taskIndex];
  if (selected === undefined) {
    throw new Error(`missing fixture assignment ${taskIndex}`);
  }
  return selected;
}

function firstKnownConcernId(manifest: PlanningBenchmarkManifest, taskIndex: number): string {
  const concernId = manifest.tasks[taskIndex]?.knownConcerns[0]?.id;
  if (concernId === undefined) {
    throw new Error(`missing fixture concern ${taskIndex}`);
  }
  return concernId;
}

function listFiles(root: string, prefix = ''): readonly string[] {
  return readdirSync(path.join(root, prefix), { withFileTypes: true }).flatMap((entry) => {
    const relative = path.join(prefix, entry.name);
    return entry.isDirectory() ? listFiles(root, relative) : [relative];
  });
}

describe('planning benchmark corpus', () => {
  it('validates the committed ten-task risk and approval contract', () => {
    const { manifest, root } = loadPlanningBenchmark();

    expect(manifest.tasks).toHaveLength(10);
    expect(manifest.tasks.filter((task) => task.risk === 'standard')).toHaveLength(5);
    expect(manifest.tasks.filter((task) => task.risk === 'high')).toHaveLength(5);
    expect(manifest.corpusApproval).toBe('operator-approval-required');
    expect(manifest.tasks.every((task) => task.referenceApproval === manifest.corpusApproval)).toBe(
      true,
    );
    expect(() => {
      validatePlanningBenchmark(manifest, root);
    }).not.toThrow();
  });

  it('pins every benchmark role to Codex', () => {
    const config = JSON.parse(
      readFileSync(path.join(BENCHMARK_ROOT, 'provider-config.balanced.json'), 'utf8'),
    ) as { roles: Record<string, { runner: string; model: string }> };

    expect(Object.keys(config.roles)).toHaveLength(6);
    expect(
      Object.values(config.roles).every(
        (role) => role.runner === 'codex' && role.model === 'gpt-5.5',
      ),
    ).toBe(true);
  });

  it('rejects a corpus that weakens the exact task-count contract', () => {
    const { manifest, root } = loadPlanningBenchmark();
    const incomplete: PlanningBenchmarkManifest = {
      ...manifest,
      tasks: manifest.tasks.slice(1),
    };

    expect(() => {
      validatePlanningBenchmark(incomplete, root);
    }).toThrow('benchmark must contain exactly 10 tasks');
  });

  it('requires a clean workspace matching the pinned source revision', () => {
    const repository = path.join(temporaryRoot, 'workspace');
    const manifest = path.join(repository, 'benchmarks', 'planning', 'manifest.json');
    const source = path.join(repository, 'src.ts');
    mkdirSync(path.dirname(manifest), { recursive: true });
    git(repository, ['init']);
    git(repository, ['config', 'user.email', 'benchmark@example.invalid']);
    git(repository, ['config', 'user.name', 'Benchmark Fixture']);
    writeFileSync(source, 'export const value = 1;\n');
    writeJson(manifest, { workspaceRevision: 'pending' });
    git(repository, ['add', '.']);
    git(repository, ['commit', '-m', 'benchmark source']);
    const pinnedRevision = git(repository, ['rev-parse', 'HEAD']);

    writeJson(manifest, { workspaceRevision: pinnedRevision });
    git(repository, ['add', 'benchmarks/planning/manifest.json']);
    git(repository, ['commit', '-m', 'pin benchmark revision']);
    expect(() => verifyBenchmarkWorkspace(repository, pinnedRevision, manifest)).not.toThrow();

    writeFileSync(source, 'export const value = 2;\n');
    expect(() => verifyBenchmarkWorkspace(repository, pinnedRevision, manifest)).toThrow(
      'benchmark workspace must be clean',
    );
    git(repository, ['add', 'src.ts']);
    git(repository, ['commit', '-m', 'change benchmark source']);
    expect(() => verifyBenchmarkWorkspace(repository, pinnedRevision, manifest)).toThrow(
      'benchmark source differs from pinned workspace revision',
    );
  });

  it('rejects benchmark output inside the source repository', () => {
    const repository = path.join(temporaryRoot, 'workspace');
    expect(() => {
      verifyBenchmarkOutputLocation(repository, path.join(repository, 'results'));
    }).toThrow('benchmark output must be outside');
    expect(() => {
      verifyBenchmarkOutputLocation(repository, path.join(temporaryRoot, 'results'));
    }).not.toThrow();
  });

  it('builds the same pinned child environment under hostile ambient overrides', () => {
    const providerConfigText = readFileSync(
      path.join(BENCHMARK_ROOT, 'provider-config.balanced.json'),
      'utf8',
    );
    const stableAmbient: NodeJS.ProcessEnv = {
      PATH: '/fixture/bin',
      HOME: '/fixture/home',
      CODEX_HOME: '/fixture/codex',
      CLAUDE_CONFIG_DIR: '/fixture/claude',
    };
    const options = {
      providerConfigText,
      homeDir: '/benchmark/home',
      stateDir: '/benchmark/state',
      workDir: '/benchmark/work',
      runName: 'benchmark-fixture',
    };
    const clean = benchmarkChildEnvironment({ ambientEnv: stableAmbient, ...options });
    const poisoned = benchmarkChildEnvironment({
      ambientEnv: {
        ...stableAmbient,
        AGENT_QUORUM_CONFIG_OVERRIDE_JSON: '{"settings":{"quality":"quick"}}',
        AGENT_QUORUM_HOME: '/ambient/home',
        AGENT_QUORUM_PLANS_DIR: '/ambient/plans',
        AGENT_QUORUM_STATE_DIR: '/ambient/state',
        AGENT_QUORUM_WORK_DIR: '/ambient/work',
        AGENT_QUORUM_RUN_NAME: 'ambient-run',
        AGENT_QUORUM_RUN_ID: 'ambient-id',
        AGENT_QUORUM_RESUME: '1',
        AGENT_QUORUM_LOCALE: 'ru-RU',
        AGENT_QUORUM_TRANSLATE: '1',
        AGENT_QUORUM_CLARIFY: '1',
        AGENT_QUORUM_TELEGRAM_BOT_TOKEN: 'ambient-secret',
        AGENT_QUORUM_TELEGRAM_CHAT_ID: 'ambient-chat',
        AGENT_QUORUM_SECRETS_OVERRIDE_FILE: '/ambient/secrets.json',
        AGENT_QUORUM_MAX_ITERS: '99',
      },
      ...options,
    });

    expect(poisoned).toEqual(clean);
    expect(poisoned.AGENT_QUORUM_CLARIFY).toBe('0');
    expect(poisoned.AGENT_QUORUM_LOCALE).toBeUndefined();
    expect(poisoned.AGENT_QUORUM_TELEGRAM_BOT_TOKEN).toBeUndefined();
    expect(poisoned.AGENT_QUORUM_TELEGRAM_CHAT_ID).toBeUndefined();
    expect(poisoned.AGENT_QUORUM_SECRETS_OVERRIDE_FILE).toBeUndefined();
    expect(poisoned.CODEX_HOME).toBe('/fixture/codex');
    expect(poisoned.CLAUDE_CONFIG_DIR).toBe('/fixture/claude');
    expect(Object.values(poisoned)).not.toContain(undefined);
    expect(
      Object.keys(poisoned)
        .filter((key) => key.startsWith('AGENT_QUORUM_'))
        .sort(),
    ).toEqual(
      [
        'AGENT_QUORUM_CLARIFY',
        'AGENT_QUORUM_CONFIG_OVERRIDE_JSON',
        'AGENT_QUORUM_HOME',
        'AGENT_QUORUM_RUN_NAME',
        'AGENT_QUORUM_STATE_DIR',
        'AGENT_QUORUM_WORK_DIR',
      ].sort(),
    );
    expect(JSON.parse(poisoned.AGENT_QUORUM_CONFIG_OVERRIDE_JSON ?? '')).toMatchObject({
      settings: { quality: 'balanced', locale: '' },
      telegram: { clarify: '0', chatId: '' },
    });
  });
});

describe('planning benchmark blinding', () => {
  it('assigns labels reproducibly from the seed without putting the key in the bundle', () => {
    const { manifest } = loadPlanningBenchmark(DEFAULT_MANIFEST_FILE);
    const resultsFile = fixtureResults(manifest);
    const first = blindFixture(manifest, resultsFile, '-first');
    const second = blindFixture(manifest, resultsFile, '-second');

    expect(first.key).toEqual(second.key);
    expect(assignmentFor('stable-seed', manifest.tasks[0]?.id ?? '')).toEqual(
      first.key.assignments[0],
    );
    const firstFiles = [...listFiles(first.bundleDir)].sort();
    const secondFiles = [...listFiles(second.bundleDir)].sort();
    expect(firstFiles).toEqual(secondFiles);
    for (const file of firstFiles) {
      expect(readFileSync(path.join(first.bundleDir, file))).toEqual(
        readFileSync(path.join(second.bundleDir, file)),
      );
    }

    const distributedText = firstFiles
      .map((file) => readFileSync(path.join(first.bundleDir, file), 'utf8'))
      .join('\n');
    expect(distributedText).not.toContain('benchmark-reference-approval');
    expect(distributedText).not.toContain('status: clean');
    expect(distributedText).not.toContain('phase_count:');
    expect(distributedText).not.toContain('candidateLabel');
    expect(distributedText).not.toContain('comparisonLabel');
    expect(distributedText).not.toContain('.reference.md');
    expect(distributedText).not.toContain('plan.final.md');
    expect(distributedText).not.toContain('corpus/');
    expect(listFiles(first.bundleDir)).not.toContain(path.basename(first.keyFile));
  });

  it('rejects an answer key path inside the distributed bundle', () => {
    const { manifest } = loadPlanningBenchmark();
    const resultsFile = fixtureResults(manifest);
    const bundleDir = path.join(temporaryRoot, 'unsafe-bundle');

    expect(() =>
      createBlindBundle({
        resultsFile,
        outputDir: bundleDir,
        keyFile: path.join(bundleDir, 'key.json'),
        seed: 'stable-seed',
      }),
    ).toThrow('answer key must be outside');
  });
});

describe('planning benchmark scoring', () => {
  it('enforces the readiness and blind-comparison thresholds without self-approving', () => {
    const { manifest } = loadPlanningBenchmark();
    const resultsFile = fixtureResults(manifest);
    const { key, keyFile } = blindFixture(manifest, resultsFile);
    const preference = (taskIndex: number, answerKey: BlindAnswerKey): BlindPreference =>
      taskIndex < 6 ? assignment(answerKey, taskIndex).candidateLabel : 'tie';
    const firstReview = reviewFixture(manifest, key, 'reviewer-one', { preference });
    const secondReview = reviewFixture(manifest, key, 'reviewer-two', { preference });

    const report = scorePlanningBenchmark({
      resultsFile,
      keyFile,
      reviewFiles: [firstReview, secondReview],
    });

    expect(report.thresholdsPassed).toBe(true);
    expect(report.checks.standardReady.actual).toBe(4);
    expect(report.checks.highRiskReady.actual).toBe(4);
    expect(report.checks.majorityPreferred.actual).toBe(6);
    expect(report.checks.majorityWorse.actual).toBe(0);
    expect(report.checks.missedMaterialConcerns.actual).toBe(0);
    expect(report.operatorApprovalSatisfied).toBe(false);
    expect(report.accepted).toBe(false);
  });

  it('requires at least two distinct complete reviews', () => {
    const { manifest } = loadPlanningBenchmark();
    const resultsFile = fixtureResults(manifest);
    const { key, keyFile } = blindFixture(manifest, resultsFile);
    const preference = (taskIndex: number, answerKey: BlindAnswerKey): BlindPreference =>
      assignment(answerKey, taskIndex).candidateLabel;
    const review = reviewFixture(manifest, key, 'reviewer-one', { preference });

    expect(() => scorePlanningBenchmark({ resultsFile, keyFile, reviewFiles: [review] })).toThrow(
      'at least 2 independent reviews',
    );
    expect(() =>
      scorePlanningBenchmark({ resultsFile, keyFile, reviewFiles: [review, review] }),
    ).toThrow('reviewer IDs must be distinct');
  });

  it('fails on any expert-discovered blocker or major concern in the generated plan', () => {
    const { manifest } = loadPlanningBenchmark();
    const resultsFile = fixtureResults(manifest);
    const { key, keyFile } = blindFixture(manifest, resultsFile);
    const preference = (taskIndex: number, answerKey: BlindAnswerKey): BlindPreference =>
      taskIndex < 6 ? assignment(answerKey, taskIndex).candidateLabel : 'tie';
    const firstReview = reviewFixture(manifest, key, 'reviewer-one', { preference });
    const secondReview = reviewFixture(manifest, key, 'reviewer-two', {
      preference,
      findings: (taskIndex, answerKey) =>
        taskIndex === 0
          ? [
              {
                plan: assignment(answerKey, taskIndex).candidateLabel,
                severity: 'major',
                claim: 'The generated plan misses the additive parser compatibility path.',
                knownConcernId: firstKnownConcernId(manifest, taskIndex),
              },
            ]
          : [],
    });

    const report = scorePlanningBenchmark({
      resultsFile,
      keyFile,
      reviewFiles: [firstReview, secondReview],
    });

    expect(report.thresholdsPassed).toBe(false);
    expect(report.checks.missedMaterialConcerns.actual).toBe(1);
    expect(report.checks.missedMaterialConcerns.passed).toBe(false);
  });

  it('requires explicit candidate adjudication for every known material concern', () => {
    const { manifest } = loadPlanningBenchmark();
    const resultsFile = fixtureResults(manifest);
    const { key, keyFile } = blindFixture(manifest, resultsFile);
    const preference = (taskIndex: number, answerKey: BlindAnswerKey): BlindPreference =>
      assignment(answerKey, taskIndex).candidateLabel;
    const firstReview = reviewFixture(manifest, key, 'reviewer-one', {
      preference,
      knownConcernDisposition: (taskIndex, plan, _knownConcernId, answerKey) =>
        taskIndex === 0 && plan === assignment(answerKey, taskIndex).candidateLabel
          ? 'missed'
          : 'addressed',
    });
    const secondReview = reviewFixture(manifest, key, 'reviewer-two', { preference });

    const report = scorePlanningBenchmark({
      resultsFile,
      keyFile,
      reviewFiles: [firstReview, secondReview],
    });
    expect(report.checks.missedMaterialConcerns.actual).toBe(1);
    expect(report.thresholdsPassed).toBe(false);

    const incomplete = JSON.parse(readFileSync(secondReview, 'utf8')) as BlindReview;
    const firstTask = incomplete.tasks[0];
    if (firstTask === undefined) {
      throw new Error('missing first task fixture');
    }
    writeJson(secondReview, {
      ...incomplete,
      tasks: [
        { ...firstTask, knownConcernAssessments: firstTask.knownConcernAssessments.slice(1) },
        ...incomplete.tasks.slice(1),
      ],
    });
    expect(() =>
      scorePlanningBenchmark({
        resultsFile,
        keyFile,
        reviewFiles: [firstReview, secondReview],
      }),
    ).toThrow('must assess every known concern for both plans');
  });

  it('fails when any task has a strict majority-worse result', () => {
    const { manifest } = loadPlanningBenchmark();
    const resultsFile = fixtureResults(manifest);
    const { key, keyFile } = blindFixture(manifest, resultsFile);
    const preference = (taskIndex: number, answerKey: BlindAnswerKey): BlindPreference =>
      taskIndex === 0
        ? assignment(answerKey, taskIndex).comparisonLabel
        : assignment(answerKey, taskIndex).candidateLabel;
    const firstReview = reviewFixture(manifest, key, 'reviewer-one', { preference });
    const secondReview = reviewFixture(manifest, key, 'reviewer-two', { preference });

    const report = scorePlanningBenchmark({
      resultsFile,
      keyFile,
      reviewFiles: [firstReview, secondReview],
    });

    expect(report.checks.majorityWorse.actual).toBe(1);
    expect(report.checks.majorityWorse.passed).toBe(false);
    expect(report.thresholdsPassed).toBe(false);
  });

  it('scores a split reviewer vote as a tie', () => {
    const { manifest } = loadPlanningBenchmark();
    const resultsFile = fixtureResults(manifest);
    const { key, keyFile } = blindFixture(manifest, resultsFile);
    const firstPreference = (taskIndex: number, answerKey: BlindAnswerKey): BlindPreference =>
      assignment(answerKey, taskIndex).candidateLabel;
    const secondPreference = (taskIndex: number, answerKey: BlindAnswerKey): BlindPreference =>
      taskIndex === 0
        ? assignment(answerKey, taskIndex).comparisonLabel
        : assignment(answerKey, taskIndex).candidateLabel;
    const firstReview = reviewFixture(manifest, key, 'reviewer-one', {
      preference: firstPreference,
    });
    const secondReview = reviewFixture(manifest, key, 'reviewer-two', {
      preference: secondPreference,
    });

    const report = scorePlanningBenchmark({
      resultsFile,
      keyFile,
      reviewFiles: [firstReview, secondReview],
    });

    expect(report.tasks[0]?.comparison).toBe('tie');
    expect(report.checks.majorityWorse.actual).toBe(0);
  });

  it('fails when fewer than four tasks in either risk class are ready in time', () => {
    const { manifest } = loadPlanningBenchmark();
    const resultsFile = fixtureResults(manifest, { standardReady: 3, highReady: 3 });
    const { key, keyFile } = blindFixture(manifest, resultsFile);
    const preference = (taskIndex: number, answerKey: BlindAnswerKey): BlindPreference =>
      assignment(answerKey, taskIndex).candidateLabel;
    const firstReview = reviewFixture(manifest, key, 'reviewer-one', { preference });
    const secondReview = reviewFixture(manifest, key, 'reviewer-two', { preference });

    const report = scorePlanningBenchmark({
      resultsFile,
      keyFile,
      reviewFiles: [firstReview, secondReview],
    });

    expect(report.checks.standardReady.actual).toBe(3);
    expect(report.checks.highRiskReady.actual).toBe(3);
    expect(report.thresholdsPassed).toBe(false);
  });
});
