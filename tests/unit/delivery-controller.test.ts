import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runDeliveryStep, type DeliveryServices } from '../../src/delivery/controller.js';
import {
  contentDigest,
  digest,
  DAY_LIMIT_MS,
  DELIVERY_OPERATIONS,
  DELIVERY_REPOSITORY,
  DeliveryError,
  ISSUE_LIMIT_MS,
  REPAIR_LIMIT,
  type AcceptanceCriterion,
  type Mandate,
  type DeliveryFinding,
} from '../../src/delivery/contract.js';
import { EditBroker } from '../../src/delivery/edits.js';
import { DeliveryLedger } from '../../src/delivery/ledger.js';
import {
  assessRequiredChecks,
  DeliveryGitHub,
  deliveryOperationMarker,
  GitHubOperationError,
  type GitHubCheck,
  type GitHubIssue,
  type GitHubPullRequest,
} from '../../src/delivery/github.js';
import type { WorkerResult } from '../../src/delivery/worker.js';
import { reopenDeliveryIssue } from '../../src/delivery/main.js';

let root: string;
let ledger: DeliveryLedger;
const CHECKS = [{ context: 'ci', appId: 1 }];
const BASE = '1'.repeat(40);

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'delivery-controller.'));
  ledger = new DeliveryLedger(path.join(root, 'ledger'));
  const mandate: Mandate = {
    version: 1,
    repository: DELIVERY_REPOSITORY,
    base: 'main',
    sourceRoot: root,
    runtimeRoot: root,
    controllerDigest: 'policy',
    profileDigest: 'profile',
    policyVersion: 1,
    profile: {
      worker: { model: 'existing-model', reasoning: 'high' },
      reviewer: { model: 'existing-model', reasoning: 'high' },
      planning: {
        configFile: path.join(root, 'planning.json'),
        quality: 'balanced',
        maxIterations: 3,
        maxRuns: 2,
      },
      bounds: {
        providerStartsPerIssue: 20,
        providerStartsPerDay: 60,
        providerTimeoutMs: 10000,
        providerRetries: 1,
        providerRetryDelayMs: 1,
        commandTimeoutMs: 10000,
        liveStartsPerScenario: 2,
        liveScenarioTimeoutMs: 1000,
      },
      scope: { include: [], exclude: [], priorities: [] },
    },
    requiredChecks: CHECKS,
    actor: 'operator',
    mcpServerNames: [],
    mcpConfigurationDigest: 'b'.repeat(64),
    workflowTreeSha: 'b'.repeat(40),
    issueLimitMs: ISSUE_LIMIT_MS,
    dailyLimitMs: DAY_LIMIT_MS,
    repairLimit: REPAIR_LIMIT,
    timezone: 'Europe/Moscow',
    operations: DELIVERY_OPERATIONS,
    releases: false,
    createdAt: '2026-09-05T00:00:00.000Z',
  };
  ledger.prepare(mandate);
  ledger.changeMode('active', 'test activation');
});
afterEach(() => {
  ledger.close();
  rmSync(root, { recursive: true, force: true });
});

function issue(number: number): GitHubIssue {
  return {
    number,
    nodeId: `I${number}`,
    title: `Clarify documentation ${number}`,
    body: `Original observed problem ${number}`,
    state: 'open',
    updatedAt: '2026-09-05T00:00:00.000Z',
    url: `https://github.com/eventbalancer/agent-quorum/issues/${number}`,
    labels: [],
    assignees: [],
  };
}

function acceptance(number: number): readonly AcceptanceCriterion[] {
  return [
    {
      id: `AC-${number}`,
      outcome: `Document issue ${number}`,
      evidence: [`README.md contains Issue ${number}`],
    },
  ];
}

function answer(action: WorkerResult['action'], number: number): WorkerResult {
  return {
    action,
    acceptance: acceptance(number),
    decisions: ['Use the existing documentation format.'],
    dependencies: [],
    findings: [],
    requiresPlan: false,
    rationale: 'Current behavior confirms the original problem.',
    relatedIssue: null,
    edits: [],
    targetedTests: [],
    uncertainty: '',
  };
}

interface ScenarioOptions {
  readonly requiresPlan?: boolean;
  readonly materialReview?: boolean;
  readonly staleChecks?: boolean;
  readonly failedMainChecks?: boolean;
}

function scenario(numbers: readonly number[], options: ScenarioOptions = {}) {
  const issues = new Map(numbers.map((number) => [number, issue(number)]));
  const pulls = new Map<number, GitHubPullRequest>();
  const committedTrees = new Map<string, string>();
  const heads = new Map<number, string>();
  const committedContents = new Map<number, string>();
  const calls: string[] = [];
  let main = BASE;
  let mainText = '# Repository\n';
  let sequence = 0;
  const readIssue = (number: number) => {
    const selected = issues.get(number);
    if (selected === undefined) {
      throw new Error('fixture issue missing');
    }
    return selected;
  };
  const readPull = (number: number) => {
    const selected = pulls.get(number);
    if (selected === undefined) {
      throw new Error('fixture pull missing');
    }
    return selected;
  };
  const readme = (worktree: string) => readFileSync(path.join(worktree, 'README.md'), 'utf8');
  const getChecks = (sha: string): Promise<GitHubCheck[]> =>
    Promise.resolve([
      {
        id: 1,
        context: 'ci',
        appId: 1,
        sha: options.staleChecks === true && sha !== main ? BASE : sha,
        status: 'completed',
        conclusion:
          options.failedMainChecks === true && sha === main && main !== BASE
            ? 'failure'
            : 'success',
        url: 'https://github.com/check/1',
      },
    ]);
  const services: DeliveryServices = {
    now: () => Date.parse('2026-09-05T10:00:00.000Z'),
    github: {
      getMain: () => Promise.resolve(main),
      getChecks,
      listIssues: (state) =>
        Promise.resolve(
          [...issues.values()].filter((candidate) => state === 'all' || candidate.state === 'open'),
        ),
      listPullRequests: () =>
        Promise.resolve([...pulls.values()].filter((candidate) => !candidate.merged)),
      getDependencies: () => Promise.resolve([]),
      getIssue: (number) => Promise.resolve(readIssue(number)),
      getPullRequest: (number) => Promise.resolve(readPull(number)),
      inspectPrerequisites: () =>
        Promise.resolve({ allowed: true, blockers: [], requiredChecks: CHECKS, mainSha: main }),
      assessCandidate: async (input) => {
        const checkSha = input.expectedCheckSha ?? input.expectedHeadSha;
        const checks = await getChecks(checkSha);
        const blockers = assessRequiredChecks(checkSha, CHECKS, checks);
        return {
          allowed: blockers.length === 0,
          blockers,
          pullRequest: readPull(input.number),
          checks,
          mainSha: main,
        };
      },
      reconcileCreation: () => Promise.resolve({ status: 'absent' as const }),
      createIssue: () => Promise.reject(new Error('unexpected issue creation')),
      updateIssue: (number, update) => {
        const updated = { ...readIssue(number), ...update };
        issues.set(number, updated);
        calls.push(`actualize:${number}`);
        return Promise.resolve(updated);
      },
      closeIssue: (number) => {
        const updated = { ...readIssue(number), state: 'closed' };
        issues.set(number, updated);
        calls.push(`close:${number}`);
        return Promise.resolve(updated);
      },
      createPullRequest: (input) => {
        const number = Number(input.head.split('-').at(-1));
        const headSha = heads.get(number);
        if (headSha === undefined) {
          throw new Error('fixture head missing');
        }
        const pull: GitHubPullRequest = {
          number: number + 100,
          nodeId: `P${number}`,
          title: input.title,
          body: input.body,
          state: 'open',
          draft: false,
          url: `https://github.com/pull/${number}`,
          headSha,
          headRef: input.head,
          baseSha: main,
          baseRef: 'main',
          merged: false,
          mergeCommitSha: null,
        };
        pulls.set(pull.number, pull);
        calls.push(`pr:${number}`);
        return Promise.resolve(pull);
      },
      updatePullRequest: (number, update) => Promise.resolve({ ...readPull(number), ...update }),
      mergePullRequest: (input) => {
        const pull = readPull(input.number);
        const number = input.number - 100;
        if (pull.headSha !== input.expectedHeadSha) {
          throw new Error('stale fixture merge');
        }
        main = contentDigest(`merge-${number}`).slice(0, 40);
        mainText = committedContents.get(number) ?? '';
        committedTrees.set(main, contentDigest(mainText));
        pulls.set(input.number, { ...pull, merged: true, mergeCommitSha: main });
        calls.push(`merge:${number}`);
        return Promise.resolve({ merged: true as const, sha: main });
      },
      listProjectItems: () => Promise.resolve([]),
      addProjectItem: () => Promise.resolve('item'),
      updateProjectItemStatus: () => Promise.resolve(),
    },
    repository: {
      finalizeWorktree: (_worktree, number) => {
        calls.push(`finalize:${number}`);
        return Promise.resolve();
      },
      createWorktree: (number, base) => {
        const worktree = path.join(root, `issue-${number}`);
        mkdirSync(worktree);
        writeFileSync(path.join(worktree, 'README.md'), mainText);
        heads.set(number, base);
        committedContents.set(number, mainText);
        calls.push(`worktree:${number}:${base}`);
        return Promise.resolve({ worktree, branch: `codex/issue-${number}` });
      },
      treeDigest: (worktree) => Promise.resolve(contentDigest(readme(worktree))),
      changedPaths: () => Promise.resolve(['README.md']),
      verify: (_worktree, command, number) => {
        calls.push(`verify:${number}:${command.join(' ')}`);
        return Promise.resolve({ exitCode: 0, stdout: 'passed', stderr: '' });
      },
      commit: (worktree, number) => {
        const text = readme(worktree);
        const sha = contentDigest(`commit-${number}-${text}`).slice(0, 40);
        committedTrees.set(sha, contentDigest(text));
        heads.set(number, sha);
        committedContents.set(number, text);
        calls.push(`commit:${number}`);
        return Promise.resolve(sha);
      },
      git: (worktree, args, number) => {
        if (args[0] === 'status') {
          return Promise.resolve(
            readme(worktree) === committedContents.get(number) ? '' : ' M README.md',
          );
        }
        if (args[0] === 'diff') {
          return Promise.resolve(readme(worktree));
        }
        if (args[0] === 'push') {
          calls.push(`push:${number}`);
          return Promise.resolve('');
        }
        if (args[0] === 'rev-parse') {
          if (args[1] === 'HEAD') {
            return Promise.resolve(heads.get(number) ?? BASE);
          }
          const sha = args[1]?.replace(/\^\{tree\}$/, '') ?? '';
          return Promise.resolve(committedTrees.get(sha) ?? 'missing-tree');
        }
        return Promise.resolve('');
      },
    },
    worker: {
      work: (input) => {
        sequence += 1;
        const current = ledger.issue(input.issue);
        calls.push(`work:${input.issue}:${current?.stage ?? 'missing'}`);
        if (current?.stage === 'refine') {
          return Promise.resolve({
            invocationId: `implement-${sequence}`,
            result: {
              ...answer('refined', input.issue),
              requiresPlan: options.requiresPlan ?? false,
            },
          });
        }
        const text = readme(input.cwd);
        if (!text.includes(`Issue ${input.issue}\n`)) {
          return Promise.resolve({
            invocationId: `implement-${sequence}`,
            result: {
              ...answer('edit', input.issue),
              edits: [
                {
                  kind: 'patch',
                  path: 'README.md',
                  baseSha256: contentDigest(text),
                  mode: 420,
                  hunks: [{ before: text, after: `${text}Issue ${input.issue}\n` }],
                  content: null,
                },
              ],
            },
          });
        }
        return Promise.resolve({
          invocationId: `implement-${sequence}`,
          result: answer('ready', input.issue),
        });
      },
      review: (input) => {
        sequence += 1;
        calls.push(`review:${input.issue}`);
        return Promise.resolve({
          invocationId: `review-${sequence}`,
          result: {
            approved: options.materialReview !== true,
            findings:
              options.materialReview === true
                ? [
                    {
                      id: 'R1',
                      material: true,
                      description: 'Acceptance still fails',
                      evidence: ['README.md:1'],
                      resolution: 'open' as const,
                      resolutionEvidence: [],
                    },
                  ]
                : [],
            acceptanceEvidence: acceptance(input.issue),
            adjacentFindings: [],
            liveReuseApproved: false,
            interveningDiffDigest: '',
          },
        });
      },
    },
    plan: () => {
      calls.push('plan');
      return Promise.reject(new DeliveryError('design-plan-not-ready'));
    },
    validateLive: () => Promise.resolve(),
    live: () => {
      calls.push('live');
      return Promise.reject(new Error('docs-only change must not run live planning'));
    },
  };
  return { services, calls, issues, pulls, getMain: () => main };
}

async function until(
  services: DeliveryServices,
  predicate: () => boolean,
  maximum = 60,
): Promise<void> {
  for (let iteration = 0; iteration < maximum && !predicate(); iteration += 1) {
    await runDeliveryStep(ledger, {}, services);
  }
  expect(predicate()).toBe(true);
}

describe('autonomous issue delivery acceptance', () => {
  it('preserves original issue content across status replacement and an uncertain real adapter response', async () => {
    const fixture = scenario([1], { requiresPlan: true });
    const original = issue(1);
    const originalBody = `${original.body}\n\n${deliveryOperationMarker('originating-finding')}`;
    fixture.issues.set(1, { ...original, body: originalBody });
    const updates: string[] = [];
    let loseStatusResponse = true;
    const github = new DeliveryGitHub({
      repository: DELIVERY_REPOSITORY,
      transport: {
        request: (request) =>
          Promise.resolve().then(() => {
            expect(request.path).toBe('repos/eventbalancer/agent-quorum/issues/1');
            const previous = fixture.issues.get(1) ?? original;
            const current =
              request.method === 'PATCH' && typeof request.body?.body === 'string'
                ? { ...previous, body: request.body.body }
                : previous;
            fixture.issues.set(1, current);
            if (request.method === 'PATCH') {
              updates.push(current.body);
              if (loseStatusResponse && current.body.includes('## Delivery status')) {
                loseStatusResponse = false;
                throw new GitHubOperationError('Response lost after successful update', 'unknown');
              }
            }
            return {
              ...current,
              node_id: current.nodeId,
              updated_at: current.updatedAt,
              html_url: current.url,
            };
          }),
      },
    });
    const services: DeliveryServices = {
      ...fixture.services,
      github: {
        ...fixture.services.github,
        getIssue: (number) => github.getIssue(number),
        updateIssue: (number, update) => github.updateIssue(number, update),
      },
    };
    await until(services, () => ledger.issue(1)?.stage === 'deferred');
    expect(ledger.get('pending-status:1')).toBeDefined();
    ledger.close();
    ledger = new DeliveryLedger(path.join(root, 'ledger'));
    await until(services, () => ledger.get('pending-status:1') === undefined);
    await runDeliveryStep(ledger, {}, services);
    expect(updates).toHaveLength(2);
    expect(fixture.issues.get(1)?.body).toBe(updates[1]);
    expect(fixture.issues.get(1)?.body.startsWith(originalBody)).toBe(true);
    expect(ledger.issue(1)).toMatchObject({
      stage: 'deferred',
      originalBody,
      acceptance: acceptance(1),
    });
    expect(ledger.get('problem-revisions:1')).toBeUndefined();
    expect(
      ledger
        .effects()
        .filter((effect) => effect.kind === 'issue')
        .every((effect) => effect.state === 'completed'),
    ).toBe(true);
  });

  it('applies repeated project transitions and reconciles an uncertain transition before advancing', async () => {
    const mandate = ledger.mandate();
    ledger.changeMode('prepared', 'Configure fixture project');
    ledger.prepare({
      ...mandate,
      profile: {
        ...mandate.profile,
        project: {
          id: 'project',
          statusFieldId: 'status',
          inProgressOptionId: 'active',
          doneOptionId: 'done',
          blockedOptionId: 'deferred',
        },
      },
    });
    ledger.changeMode('active', 'Fixture authorization');
    const fixture = scenario([1], { requiresPlan: true });
    let statusOptionId: string | null = null;
    const updates: string[] = [];
    let loseDeferredResponse = true;
    const services: DeliveryServices = {
      ...fixture.services,
      github: {
        ...fixture.services.github,
        listProjectItems: () => Promise.resolve([{ id: 'item', contentId: 'I1', statusOptionId }]),
        updateProjectItemStatus: (_mapping, _item, status) => {
          updates.push(status);
          statusOptionId = status;
          if (status === 'deferred' && loseDeferredResponse) {
            loseDeferredResponse = false;
            return Promise.reject(new GitHubOperationError('Project response lost', 'unknown'));
          }
          return Promise.resolve();
        },
      },
    };
    await until(services, () => ledger.issue(1)?.stage === 'deferred');
    expect(updates).toEqual(['active', 'deferred']);
    ledger.close();
    ledger = new DeliveryLedger(path.join(root, 'ledger'));
    await until(services, () => ledger.get('pending-status:1') === undefined);
    expect(updates).toEqual(['active', 'deferred']);
    ledger.set('resume-stage:1', 'refine');
    reopenDeliveryIssue(ledger, 1, 1, 0, digest(ledger.mandate()));
    await until(services, () => ledger.issue(1)?.stage === 'plan');
    expect(updates).toEqual(['active', 'deferred', 'active']);
    expect(statusOptionId).toBe('active');
    const refined = ledger.issue(1);
    if (refined === undefined) {
      throw new Error('fixture issue missing');
    }
    ledger.saveIssue({ ...refined, stage: 'refine' });
    await runDeliveryStep(ledger, {}, services);
    expect(updates).toHaveLength(3);
    statusOptionId = 'deferred';
    ledger.saveIssue({ ...refined, stage: 'refine' });
    await runDeliveryStep(ledger, {}, services);
    expect(updates).toEqual(['active', 'deferred', 'active', 'active']);
    expect(
      ledger
        .effects()
        .filter((effect) => effect.key.startsWith('project-status:'))
        .map((effect) => effect.state),
    ).toEqual(['completed', 'completed', 'completed', 'completed']);
  });

  it('delivers two issues sequentially through edits, independent review, merge and reconciliation against current main', async () => {
    const fixture = scenario([1, 2]);
    await until(fixture.services, () => ledger.issue(2)?.stage === 'done');
    expect(ledger.issues().map((current) => current.stage)).toEqual(['done', 'done']);
    expect(fixture.calls.filter((call) => call.startsWith('merge:'))).toEqual([
      'merge:1',
      'merge:2',
    ]);
    expect(fixture.calls.indexOf('merge:1')).toBeLessThan(fixture.calls.indexOf('finalize:1'));
    expect(fixture.calls.indexOf('finalize:1')).toBeLessThan(
      fixture.calls.findIndex((call) => call.startsWith('worktree:2:')),
    );
    expect(fixture.calls.indexOf('close:1')).toBeLessThan(
      fixture.calls.findIndex((call) => call.startsWith('worktree:2:')),
    );
    expect(ledger.issue(2)?.baseSha).toBe(ledger.issue(1)?.mergedSha);
    expect(fixture.issues.get(1)?.body).toContain('Original observed problem 1');
    expect(fixture.issues.get(1)?.body).toContain('Current acceptance');
    expect(readFileSync(path.join(root, 'issue-2', 'README.md'), 'utf8')).toBe(
      '# Repository\nIssue 1\nIssue 2\n',
    );
    expect(fixture.calls).not.toContain('plan');
    expect(fixture.calls).not.toContain('live');
    expect(fixture.calls.filter((call) => call.startsWith('review:'))).toEqual([
      'review:1',
      'review:2',
    ]);
    expect(ledger.events().filter((event) => event.kind === 'delivered')).toHaveLength(2);
  });

  it('defers unresolved material findings after two repair cycles and continues an independent issue', async () => {
    const fixture = scenario([1, 2], { materialReview: true });
    await until(fixture.services, () => ledger.issue(1)?.stage === 'deferred');
    expect(ledger.issue(1)?.blocker).toBe('repair-limit');
    expect(ledger.counter('repairs:1')).toBe(2);
    expect(fixture.calls.filter((call) => call === 'review:1')).toHaveLength(3);
    expect(fixture.calls.filter((call) => call.startsWith('merge:'))).toEqual([]);
    await runDeliveryStep(ledger, {}, fixture.services);
    expect(ledger.issue(2)?.stage).toBe('refine');
  });

  it('defers a needs-review design plan before implementation starts', async () => {
    const fixture = scenario([1], { requiresPlan: true });
    await until(fixture.services, () => ledger.issue(1)?.stage === 'deferred');
    expect(ledger.issue(1)?.blocker).toBe('design-plan-not-ready');
    expect(fixture.calls).toContain('plan');
    expect(fixture.calls).not.toContain('work:1:implement');
    expect(readFileSync(path.join(root, 'issue-1', 'README.md'), 'utf8')).toBe('# Repository\n');
  });

  it('waits quietly on an empty queue without fabricating work or repeating notifications', async () => {
    const fixture = scenario([]);
    const before = ledger.events();
    for (let iteration = 0; iteration < 3; iteration += 1) {
      expect((await runDeliveryStep(ledger, {}, fixture.services)).waitMs).toBeGreaterThan(0);
    }
    expect(ledger.issues()).toEqual([]);
    expect(ledger.events()).toEqual(before);
    expect(fixture.calls).toEqual([]);
  });

  it('never merges stale required checks despite their success conclusion', async () => {
    const fixture = scenario([1], { staleChecks: true });
    await until(fixture.services, () => ledger.issue(1)?.stage === 'ci');
    for (let iteration = 0; iteration < 3; iteration += 1) {
      expect((await runDeliveryStep(ledger, {}, fixture.services)).waitMs).toBeGreaterThan(0);
    }
    expect(ledger.issue(1)?.stage).toBe('ci');
    expect(fixture.calls).not.toContain('merge:1');
    expect(ledger.events().filter((event) => event.kind === 'candidate-wait')).toHaveLength(1);
  });

  it('blocks further delivery after an unhealthy integrated main revision', async () => {
    const fixture = scenario([1, 2], { failedMainChecks: true });
    await until(fixture.services, () => ledger.mode() === 'blocked');
    expect(fixture.calls).toContain('merge:1');
    expect(fixture.calls).not.toContain('finalize:1');
    expect(ledger.issue(2)).toBeUndefined();
    expect(ledger.get<{ reason: string }>('shared-blocker')?.reason).toBe(
      'integrated-main-check-failed',
    );
    expect(existsSync(path.join(root, 'issue-2'))).toBe(false);
  });
});

function finding(kind: 'adjacent' | 'prerequisite'): DeliveryFinding {
  return {
    kind,
    title: 'Related independently deliverable problem',
    problem: 'A separately verified problem has a concrete source occurrence.',
    evidence: ['README.md:1'],
    outcome: 'Resolve the related outcome with verification.',
    uncertainty: '',
    relatedIssue: null,
  };
}

describe('delivery reconciliation and retained effects', () => {
  it.each(['resolved', 'duplicate'] as const)(
    'reconciles an evidence-backed %s issue without implementing or merging it',
    async (action) => {
      const fixture = scenario([1, 2]);
      const services: DeliveryServices = {
        ...fixture.services,
        worker: {
          ...fixture.services.worker,
          work: (input) =>
            input.issue === 1
              ? Promise.resolve({
                  invocationId: 'refinement-evidence',
                  result: {
                    ...answer(action, 1),
                    relatedIssue: action === 'duplicate' ? 2 : null,
                    rationale: 'README.md proves that the requested outcome already exists.',
                  },
                })
              : fixture.services.worker.work(input),
        },
      };
      await until(services, () => ledger.issue(1)?.stage === 'done');
      expect(fixture.issues.get(1)?.state).toBe('closed');
      expect(fixture.issues.get(1)?.body).toContain('Original observed problem 1');
      expect(fixture.issues.get(1)?.body).toContain(`Evidence-backed ${action}`);
      expect(fixture.calls).not.toContain('commit:1');
      expect(fixture.calls).not.toContain('merge:1');
      expect(ledger.events().filter((event) => event.kind === 'prior-resolution')).toHaveLength(1);
    },
  );

  it('captures an adjacent issue once after losing the create response and continues through verified merge', async () => {
    const fixture = scenario([1]);
    let creations = 0;
    let operationKey = '';
    const services: DeliveryServices = {
      ...fixture.services,
      github: {
        ...fixture.services.github,
        createIssue: (input) => {
          creations += 1;
          operationKey = input.operationKey;
          fixture.issues.set(91, {
            ...issue(91),
            title: input.title,
            body: input.body,
            state: 'closed',
          });
          return Promise.reject(new Error('Lost create response after server committed the issue'));
        },
        reconcileCreation: (input) =>
          Promise.resolve(
            input.operationKey === operationKey && creations === 1
              ? {
                  status: 'found' as const,
                  number: 91,
                  nodeId: 'I91',
                  url: 'https://github.com/issues/91',
                }
              : { status: 'absent' as const },
          ),
      },
      worker: {
        ...fixture.services.worker,
        work: async (input) => {
          const result = await fixture.services.worker.work(input);
          return ledger.issue(input.issue)?.stage === 'refine'
            ? { ...result, result: { ...result.result, findings: [finding('adjacent')] } }
            : result;
        },
      },
    };
    await until(services, () => ledger.issue(1)?.stage === 'done');
    expect(creations).toBe(1);
    expect(ledger.issues().map((current) => current.number)).toEqual([1]);
    expect(ledger.effects().filter((effect) => effect.key.startsWith('finding-create:'))).toEqual([
      expect.objectContaining({ state: 'completed' }),
    ]);
    expect(ledger.events().some((event) => event.kind === 'issue-recovered')).toBe(true);
    expect(fixture.calls.filter((call) => call === 'merge:1')).toHaveLength(1);
  });

  it('stops on a captured prerequisite and resumes its original outcome after that prerequisite closes', async () => {
    const fixture = scenario([1]);
    let creations = 0;
    const services: DeliveryServices = {
      ...fixture.services,
      github: {
        ...fixture.services.github,
        createIssue: (input) => {
          creations += 1;
          const created = { ...issue(91), title: input.title, body: input.body };
          fixture.issues.set(91, created);
          return Promise.resolve(created);
        },
      },
      worker: {
        ...fixture.services.worker,
        work: async (input) => {
          const result = await fixture.services.worker.work(input);
          return ledger.issue(input.issue)?.stage === 'refine'
            ? { ...result, result: { ...result.result, findings: [finding('prerequisite')] } }
            : result;
        },
      },
    };
    await until(services, () => ledger.issue(1)?.stage === 'deferred');
    expect(ledger.issue(1)?.blocker).toBe('blocking-prerequisite');
    expect(ledger.issue(1)?.dependencies).toEqual([91]);
    expect(fixture.calls).not.toContain('work:1:implement');
    const prerequisite = fixture.issues.get(91);
    if (prerequisite === undefined) {
      throw new Error('fixture prerequisite missing');
    }
    fixture.issues.set(91, { ...prerequisite, state: 'closed' });
    await until(services, () => ledger.issue(1)?.stage === 'done');
    expect(creations).toBe(1);
    expect(fixture.calls.filter((call) => call.startsWith('worktree:1:'))).toHaveLength(1);
  });

  it('recovers a partially applied durable edit batch without replaying completed file changes or calling a worker', async () => {
    const fixture = scenario([1]);
    await until(fixture.services, () => ledger.issue(1)?.stage === 'implement');
    const current = ledger.issue(1);
    if (current?.worktree === undefined) {
      throw new Error('fixture worktree missing');
    }
    const text = readFileSync(path.join(current.worktree, 'README.md'), 'utf8');
    const edits = [
      {
        kind: 'patch' as const,
        path: 'README.md',
        baseSha256: contentDigest(text),
        mode: 0o644,
        hunks: [{ before: text, after: `${text}Issue 1\n` }],
        content: null,
      },
      {
        kind: 'create' as const,
        path: 'docs/details.md',
        baseSha256: null,
        mode: 0o644,
        hunks: [],
        content: 'Recovered second file\n',
      },
    ];
    expect(() => {
      new EditBroker(ledger).apply(
        1,
        current.worktree ?? '',
        edits,
        'interrupted-batch',
        (index) => {
          if (index === 0) {
            throw new Error('Process stopped after first file');
          }
        },
      );
    }).toThrow('Process stopped');
    ledger.set('resume-stage:1', 'implement');
    ledger.saveIssue({ ...current, stage: 'recover' });
    const workerCalls = fixture.calls.filter((call) => call.startsWith('work:')).length;
    await runDeliveryStep(ledger, {}, fixture.services);
    expect(ledger.issue(1)?.stage).toBe('implement');
    expect(fixture.calls.filter((call) => call.startsWith('work:'))).toHaveLength(workerCalls);
    expect(readFileSync(path.join(current.worktree, 'README.md'), 'utf8')).toBe(
      '# Repository\nIssue 1\n',
    );
    expect(readFileSync(path.join(current.worktree, 'docs/details.md'), 'utf8')).toBe(
      'Recovered second file\n',
    );
    expect(ledger.effect('edit:1:interrupted-batch')?.state).toBe('completed');
    await until(fixture.services, () => ledger.issue(1)?.stage === 'done');
  });

  it('requires new verification and independent review when commit-time edits change the reviewed candidate', async () => {
    const fixture = scenario([1]);
    let mutated = false;
    const services: DeliveryServices = {
      ...fixture.services,
      repository: {
        ...fixture.services.repository,
        commit: async (worktree, number, message, identity) => {
          const sha = await fixture.services.repository.commit(worktree, number, message, identity);
          if (!mutated) {
            mutated = true;
            const file = path.join(worktree, 'README.md');
            writeFileSync(file, `${readFileSync(file, 'utf8')}Commit-time generated note\n`);
          }
          return sha;
        },
      },
    };
    await until(services, () => ledger.issue(1)?.stage === 'done');
    expect(fixture.calls.filter((call) => call === 'review:1')).toHaveLength(2);
    expect(fixture.calls.filter((call) => call === 'verify:1:pnpm run check')).toHaveLength(0);
    expect(fixture.calls.filter((call) => call === 'verify:1:run check')).toHaveLength(2);
    expect(fixture.calls.filter((call) => call === 'merge:1')).toHaveLength(1);
  });

  it('refines externally amended deferred requirements while preserving the original evidence and exact authored body ownership', async () => {
    const fixture = scenario([1], { requiresPlan: true });
    await until(fixture.services, () => ledger.issue(1)?.stage === 'deferred');
    const before = ledger.issue(1);
    const source = fixture.issues.get(1);
    if (before === undefined || source === undefined) {
      throw new Error('fixture issue missing');
    }
    fixture.issues.set(1, {
      ...source,
      title: 'Include deployment prerequisites',
      body: source.body.replace(
        'Original observed problem 1',
        'Document offline deployment prerequisites',
      ),
    });
    await runDeliveryStep(ledger, {}, fixture.services);
    expect(ledger.issue(1)).toMatchObject({
      stage: 'refine',
      title: 'Include deployment prerequisites',
      currentBody: 'Document offline deployment prerequisites',
      originalTitle: 'Clarify documentation 1',
      originalBody: 'Original observed problem 1',
      acceptance: [],
    });
    expect(ledger.get('problem-revisions:1')).toEqual([before]);
    const prompts: string[] = [];
    const services: DeliveryServices = {
      ...fixture.services,
      worker: {
        ...fixture.services.worker,
        work: (input) => {
          prompts.push(input.prompt);
          return Promise.resolve({
            invocationId: 'fresh-refinement',
            result: {
              ...answer('refined', 1),
              requiresPlan: true,
              acceptance: [
                {
                  id: 'AC-new',
                  outcome: 'Document offline deployment',
                  evidence: ['docs/deployment.md'],
                },
              ],
            },
          });
        },
      },
    };
    await runDeliveryStep(ledger, {}, services);
    expect(ledger.issue(1)?.stage).toBe('plan');
    expect(ledger.issue(1)?.acceptance[0]?.id).toBe('AC-new');
    expect(JSON.parse(prompts[0] ?? '')).toMatchObject({
      currentProblem: { body: 'Document offline deployment prerequisites' },
      originalEvidence: { body: 'Original observed problem 1' },
    });
    expect(fixture.issues.get(1)?.body).toContain('## Original issue evidence');
    expect(fixture.calls).not.toContain('work:1:implement');
  });

  it('treats an edited or forged controller block as external problem content instead of discarding it', async () => {
    const fixture = scenario([1], { requiresPlan: true });
    await until(fixture.services, () => ledger.issue(1)?.stage === 'deferred');
    const source = fixture.issues.get(1);
    if (source === undefined) {
      throw new Error('fixture issue missing');
    }
    const body = source.body.replace(
      'Deferred: design-plan-not-ready.',
      'Additional acceptance: preserve exported data.',
    );
    fixture.issues.set(1, { ...source, body });
    await runDeliveryStep(ledger, {}, fixture.services);
    expect(ledger.issue(1)?.stage).toBe('refine');
    expect(ledger.issue(1)?.currentBody).toBe(body);
    expect(ledger.issue(1)?.originalBody).toBe('Original observed problem 1');
  });

  it('does not overwrite an external amendment that arrives during refinement', async () => {
    const fixture = scenario([1]);
    const services: DeliveryServices = {
      ...fixture.services,
      worker: {
        ...fixture.services.worker,
        work: async (input) => {
          const result = await fixture.services.worker.work(input);
          const source = fixture.issues.get(1);
          if (source === undefined) {
            throw new Error('fixture issue missing');
          }
          fixture.issues.set(1, {
            ...source,
            body: 'New requirement added while the provider was running',
          });
          return result;
        },
      },
    };
    await until(services, () => ledger.issue(1)?.stage === 'deferred');
    expect(ledger.issue(1)?.blocker).toBe('issue-problem-changed');
    expect(ledger.issue(1)?.currentBody).toBe(
      'New requirement added while the provider was running',
    );
    expect(ledger.issue(1)?.acceptance).toEqual([]);
    expect(fixture.issues.get(1)?.body).toContain(
      'New requirement added while the provider was running',
    );
    expect(fixture.issues.get(1)?.body).not.toContain('## Current acceptance');
    expect(ledger.get('resume-stage:1')).toBe('refine');
  });

  it('rechecks changed acceptance at the merge boundary before issuing a merge', async () => {
    const fixture = scenario([1]);
    await until(fixture.services, () => ledger.issue(1)?.stage === 'merge');
    const source = fixture.issues.get(1);
    if (source === undefined) {
      throw new Error('fixture issue missing');
    }
    fixture.issues.set(1, { ...source, body: `${source.body}\nAlso describe failure recovery.` });
    await runDeliveryStep(ledger, {}, fixture.services);
    expect(ledger.issue(1)?.stage).toBe('refine');
    expect(ledger.get('review:1')).toBeUndefined();
    expect(fixture.calls).not.toContain('merge:1');
  });

  it('preserves failed plan artifacts and rotates logical attempts only after reopening within cumulative limits', async () => {
    const fixture = scenario([1], { requiresPlan: true });
    const outputs: string[] = [];
    const services: DeliveryServices = {
      ...fixture.services,
      plan: (_issue, output) => {
        outputs.push(output);
        mkdirSync(output, { recursive: true });
        writeFileSync(path.join(output, 'plan.v0.md'), `Preserved attempt ${outputs.length}`);
        return Promise.reject(new DeliveryError('design-plan-not-ready'));
      },
    };
    await until(services, () => ledger.issue(1)?.stage === 'deferred');
    const source = fixture.issues.get(1);
    if (source === undefined) {
      throw new Error('fixture issue missing');
    }
    fixture.issues.set(1, {
      ...source,
      labels: ['documentation'],
      updatedAt: '2026-09-05T10:01:00.000Z',
    });
    expect((await runDeliveryStep(ledger, {}, services)).waitMs).toBeGreaterThan(0);
    expect(outputs).toHaveLength(1);
    reopenDeliveryIssue(ledger, 1, 1, 0, digest(ledger.mandate()));
    await runDeliveryStep(ledger, {}, services);
    expect(outputs).toHaveLength(2);
    expect(outputs[0]).not.toBe(outputs[1]);
    expect(readFileSync(path.join(outputs[0] ?? '', 'plan.v0.md'), 'utf8')).toBe(
      'Preserved attempt 1',
    );
    reopenDeliveryIssue(ledger, 1, 1, 0, digest(ledger.mandate()));
    await runDeliveryStep(ledger, {}, services);
    expect(ledger.issue(1)?.blocker).toBe('design-attempt-limit');
    expect(outputs).toHaveLength(2);
    expect(ledger.counter('design:1')).toBe(2);
    reopenDeliveryIssue(ledger, 1, 0, 0, digest(ledger.mandate()), { designRuns: 1 });
    await runDeliveryStep(ledger, {}, services);
    expect(outputs).toHaveLength(3);
    expect(ledger.counter('design:1')).toBe(3);
  });

  it('retains the same exact planning output and reservation when cancellation loses the completed response', async () => {
    const fixture = scenario([1], { requiresPlan: true });
    await until(fixture.services, () => ledger.issue(1)?.stage === 'plan');
    const control = new AbortController();
    const outputs: string[] = [];
    const services: DeliveryServices = {
      ...fixture.services,
      plan: (_issue, output) => {
        outputs.push(output);
        const planPath = path.join(output, 'plan.final.md');
        if (!existsSync(planPath)) {
          mkdirSync(output, { recursive: true });
          writeFileSync(planPath, '# Completed, strictly admitted plan');
          control.abort();
          return Promise.reject(new Error('Cancelled before controller received the final plan'));
        }
        return Promise.resolve({
          workDir: output,
          planPath,
          canonicalPlanSha256: contentDigest(readFileSync(planPath)),
        });
      },
    };
    await runDeliveryStep(ledger, { signal: control.signal }, services);
    expect(ledger.get('design-pending:1')).toMatchObject({ state: 'pending' });
    ledger.changeMode('active', 'Resume interrupted planning');
    await runDeliveryStep(ledger, {}, services);
    expect(ledger.issue(1)?.stage).toBe('implement');
    expect(outputs[1]).toBe(outputs[0]);
    expect(ledger.counter('design:1')).toBe(1);
  });

  it('permits one new bounded plan after relevant source inputs change without an issue metadata update', async () => {
    const fixture = scenario([1], { requiresPlan: true });
    await until(fixture.services, () => ledger.issue(1)?.stage === 'deferred');
    const previous = ledger.get<{ output: string }>('design-pending:1');
    const worktree = ledger.issue(1)?.worktree;
    if (worktree === undefined) {
      throw new Error('fixture worktree missing');
    }
    writeFileSync(path.join(worktree, 'README.md'), '# Updated design context\n');
    await runDeliveryStep(ledger, {}, fixture.services);
    expect(ledger.issue(1)?.stage).toBe('plan');
    await runDeliveryStep(ledger, {}, fixture.services);
    expect(ledger.get<{ output: string }>('design-pending:1')?.output).not.toBe(previous?.output);
    expect(ledger.counter('design:1')).toBe(2);
    expect(ledger.issue(1)?.stage).toBe('deferred');
  });

  it('retries rejected deferred status with cooldown while preserving the implementation blocker and resume stage', async () => {
    const fixture = scenario([1], { requiresPlan: true });
    let time = fixture.services.now();
    let statusCalls = 0;
    const services: DeliveryServices = {
      ...fixture.services,
      now: () => time,
      github: {
        ...fixture.services.github,
        updateIssue: (number, update) => {
          if (update.body?.includes('## Delivery status') === true && ++statusCalls <= 2) {
            return Promise.reject(
              new GitHubOperationError('Temporary status rejection', 'rejected'),
            );
          }
          return fixture.services.github.updateIssue(number, update);
        },
      },
    };
    await until(services, () => ledger.issue(1)?.stage === 'deferred');
    expect(statusCalls).toBe(1);
    const blocker = ledger.issue(1)?.blocker;
    const condition = ledger.issue(1)?.reconsiderWhen;
    await runDeliveryStep(ledger, {}, services);
    expect(ledger.issue(1)?.stage).toBe('recover');
    await runDeliveryStep(ledger, {}, services);
    expect(statusCalls).toBe(2);
    expect(ledger.issue(1)).toMatchObject({
      stage: 'deferred',
      blocker,
      reconsiderWhen: condition,
    });
    expect(ledger.get('resume-stage:1')).toBe('plan');
    expect((await runDeliveryStep(ledger, {}, services)).waitMs).toBeGreaterThan(0);
    expect(statusCalls).toBe(2);
    time += 60_000;
    await runDeliveryStep(ledger, {}, services);
    await runDeliveryStep(ledger, {}, services);
    expect(statusCalls).toBe(3);
    expect(ledger.get('pending-status:1')).toBeUndefined();
    expect(ledger.issue(1)).toMatchObject({
      stage: 'deferred',
      blocker,
      reconsiderWhen: condition,
    });
    expect(ledger.get('resume-stage:1')).toBe('plan');
    expect(fixture.calls.filter((call) => call === 'plan')).toHaveLength(1);
  });

  it('normalizes a recovered commit receipt to the broker output shape', async () => {
    const fixture = scenario([1]);
    await until(fixture.services, () => ledger.issue(1)?.stage === 'implement');
    const current = ledger.issue(1);
    if (current === undefined) {
      throw new Error('fixture issue missing');
    }
    ledger.intendEffect({
      key: 'commit:lost',
      kind: 'commit',
      issue: 1,
      state: 'intended',
      input: {},
    });
    ledger.set('resume-stage:1', 'commit');
    ledger.saveIssue({ ...current, stage: 'recover' });
    const services: DeliveryServices = {
      ...fixture.services,
      repository: {
        ...fixture.services.repository,
        git: (worktree, args, number) =>
          args[0] === 'log'
            ? Promise.resolve('a'.repeat(40))
            : fixture.services.repository.git(worktree, args, number),
      },
    };
    await runDeliveryStep(ledger, {}, services);
    expect(ledger.effect('commit:lost')?.output).toEqual({ sha: 'a'.repeat(40) });
    expect(ledger.issue(1)?.stage).toBe('commit');
  });
});
