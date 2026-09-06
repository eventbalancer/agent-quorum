import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  assertExecutionAllowed,
  ExecutionControlError,
  type ExecutionControl,
} from '../runtime/execution-control.js';
import {
  contentDigest,
  DeliveryError,
  digest,
  scopeIncludes,
  type DeliveryFinding,
  type DeliveryIssue,
  type IssueStage,
  type Mandate,
} from './contract.js';
import { RepositoryBroker, runDeliveryCommand } from './commands.js';
import { assertNoReleaseEdit, EditBroker } from './edits.js';
import {
  admitReview,
  admitVerification,
  type ReviewReceipt,
  type VerificationReceipt,
} from './evidence.js';
import {
  admitLiveReceipt,
  isLiveReuseEligible,
  validateLiveExecutionSummary,
  needsLiveGate,
  REQUIRED_LIVE_SCENARIOS,
  type LiveReceipt,
} from './live-evidence.js';
import {
  DeliveryGitHub,
  GitHubOperationError,
  assessRequiredChecks,
  createGhTransport,
  githubCredentialEnvironment,
  readExistingGitHubToken,
  type GitHubIssue,
  type GitHubProjectMapping,
  type GitHubTransport,
} from './github.js';
import { DeliveryLedger, type EffectRecord } from './ledger.js';
import { runDeliveryPlan, type DeliveryPlanResult } from './plan-runner.js';
import { foreignSessions } from './session-ownership.js';
import { evidenceDecoderAcceptance } from './evidence-decoder.js';
import {
  adoptReviewedEvidenceDecoder,
  planningDecoderContext,
  readApprovedEvidenceDecoder,
  readEvidenceDecoderProposal,
} from './evidence-decoder-registry.js';
import {
  CodexDeliveryWorker,
  type ReviewerResult,
  type WorkerAnswer,
  type WorkerCall,
  type WorkerResult,
} from './worker.js';

export interface DeliveryStepResult {
  readonly waitMs: number;
}

export interface DeliveryServices {
  readonly github: Pick<
    DeliveryGitHub,
    | 'getMain'
    | 'getChecks'
    | 'listIssues'
    | 'listPullRequests'
    | 'getDependencies'
    | 'getIssue'
    | 'getPullRequest'
    | 'inspectPrerequisites'
    | 'assessCandidate'
    | 'reconcileCreation'
    | 'createIssue'
    | 'updateIssue'
    | 'closeIssue'
    | 'createPullRequest'
    | 'updatePullRequest'
    | 'mergePullRequest'
    | 'listProjectItems'
    | 'addProjectItem'
    | 'updateProjectItemStatus'
  >;
  readonly repository: Pick<
    RepositoryBroker,
    | 'git'
    | 'verify'
    | 'treeDigest'
    | 'changedPaths'
    | 'createWorktree'
    | 'commit'
    | 'finalizeWorktree'
  >;
  readonly worker: {
    work(input: WorkerCall): Promise<WorkerAnswer<WorkerResult>>;
    review(input: WorkerCall): Promise<WorkerAnswer<ReviewerResult>>;
  };
  readonly plan: (issue: DeliveryIssue, workDir: string) => Promise<DeliveryPlanResult>;
  readonly live: (
    issue: DeliveryIssue,
    outputDir: string,
    execution: ExecutionControl,
  ) => Promise<void>;
  readonly validateLive: (issue: DeliveryIssue, receipt: LiveReceipt) => Promise<void>;
  readonly now: () => number;
}

const IDLE_WAIT_MS = 300_000;
const CI_WAIT_MS = 60_000;

interface DesignAttempt {
  readonly inputDigest: string;
  readonly output: string;
  readonly identity: string;
  readonly state: 'pending' | 'terminal';
}

type ProjectStatus = 'active' | 'done' | 'deferred';

interface ProjectTransition {
  readonly generation: number;
  readonly key: string;
  readonly status: ProjectStatus;
}

function issueArtifact(ledger: DeliveryLedger, issue: number, name: string): string {
  const directory = path.join(ledger.directory, 'artifacts', String(issue));
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return path.join(directory, name);
}

function activeIssue(ledger: DeliveryLedger): DeliveryIssue | undefined {
  const issues = ledger
    .issues()
    .filter((issue) => issue.stage !== 'done' && issue.stage !== 'deferred');
  if (issues.length > 1) {
    throw new DeliveryError('multiple-active-delivery-issues', true);
  }
  return issues[0];
}

function requireWorktree(issue: DeliveryIssue): string {
  if (issue.worktree === undefined) {
    throw new DeliveryError('owned-worktree-missing');
  }
  return issue.worktree;
}

function projectMapping(mandate: Mandate): GitHubProjectMapping | undefined {
  const mapping = mandate.profile.project;
  if (mapping === undefined) {
    return undefined;
  }
  return {
    projectId: mapping.id,
    statusFieldId: mapping.statusFieldId,
    statusOptions: {
      active: mapping.inProgressOptionId,
      done: mapping.doneOptionId,
      deferred: mapping.blockedOptionId,
    },
  };
}

async function externalEffect<T>(
  ledger: DeliveryLedger,
  effect: EffectRecord,
  execute: () => Promise<T>,
  reconcile: () => Promise<T | undefined>,
): Promise<T> {
  const previous = ledger.effect(effect.key);
  if (previous?.state === 'completed') {
    return previous.output as T;
  }
  if (previous !== undefined && previous.state !== 'rejected') {
    const recovered = await reconcile();
    if (recovered !== undefined) {
      ledger.finishEffect(effect.key, 'completed', recovered);
      return recovered;
    }
    throw new DeliveryError('uncertain-external-effect');
  }
  ledger.intendEffect(effect);
  if (previous?.state === 'rejected') {
    ledger.finishEffect(effect.key, 'intended');
  }
  ledger.assertAuthorized(effect.kind, effect.issue);
  try {
    const result = await execute();
    ledger.finishEffect(effect.key, 'completed', result);
    return result;
  } catch (error) {
    const state =
      error instanceof GitHubOperationError && error.outcome === 'rejected'
        ? 'rejected'
        : 'unknown';
    ledger.finishEffect(effect.key, state);
    throw error;
  }
}

function matchesIssue(body: string, number: number): boolean {
  return new RegExp(`(?:^|[^0-9])#${number}(?![0-9])`).test(body);
}

function priority(issue: GitHubIssue, mandate: Mandate): number {
  const ordered = mandate.profile.scope.priorities.indexOf(issue.number);
  if (ordered >= 0) {
    return ordered;
  }
  const text = `${issue.title} ${issue.labels.join(' ')}`.toLowerCase();
  const category = /(?:bug|correctness|blocker|regression)/.test(text)
    ? 1
    : /(?:autonom|delivery|recovery|reliability)/.test(text)
      ? 2
      : 3;
  return 1_000_000 + category * 1_000_000 + issue.number;
}

class DeliveryController {
  readonly mandate: Mandate;

  constructor(
    readonly ledger: DeliveryLedger,
    readonly execution: ExecutionControl,
    readonly services: DeliveryServices,
  ) {
    this.mandate = ledger.mandate();
  }

  private save(issue: DeliveryIssue): void {
    this.ledger.transaction(() => {
      this.ledger.saveIssue(issue);
      this.ledger.set(
        'current-issue',
        issue.stage === 'done' || issue.stage === 'deferred' ? 0 : issue.number,
      );
    });
  }

  private beginRepair(issue: number, identity: string): void {
    if (this.ledger.get<string>(`repair-active:${issue}`) !== undefined) {
      return;
    }
    this.ledger.reserveRepair(issue, identity);
    this.ledger.set(`repair-active:${issue}`, identity);
  }

  private problemBody(issue: DeliveryIssue, body: string): string {
    const authored =
      this.ledger.get<{ suffix: string; digest: string }[]>(
        `authored-body-blocks:${issue.number}`,
      ) ?? [];
    const match = authored.find(
      (block) => contentDigest(block.suffix) === block.digest && body.endsWith(block.suffix),
    );
    return match === undefined ? body : body.slice(0, -match.suffix.length);
  }

  private problemChanged(issue: DeliveryIssue, current: GitHubIssue): boolean {
    return (
      current.title !== issue.title ||
      this.problemBody(issue, current.body) !== (issue.currentBody ?? issue.originalBody)
    );
  }

  private observeProblem(issue: DeliveryIssue, current: GitHubIssue): DeliveryIssue {
    if (!this.problemChanged(issue, current)) {
      return issue;
    }
    const revisions = this.ledger.get<DeliveryIssue[]>(`problem-revisions:${issue.number}`) ?? [];
    const preserved = { ...issue };
    for (const field of ['designWorkDir', 'blocker', 'reconsiderWhen', 'feedback']) {
      Reflect.deleteProperty(preserved, field);
    }
    const updated: DeliveryIssue = {
      ...preserved,
      title: current.title,
      originalTitle: issue.originalTitle ?? issue.title,
      currentBody: this.problemBody(issue, current.body),
      stage: 'refine',
      acceptance: [],
      decisions: [],
      dependencies: [],
      findingKeys: [],
    };
    this.ledger.transaction(() => {
      this.ledger.set(`problem-revisions:${issue.number}`, [...revisions, issue]);
      this.ledger.set(`resume-stage:${issue.number}`, 'refine');
      this.ledger.unset(`pending-status:${issue.number}`);
      this.ledger.unset(`verification:${issue.number}`);
      this.ledger.unset(`review:${issue.number}`);
      this.ledger.saveIssue(updated);
      this.ledger.set('current-issue', updated.number);
    });
    this.ledger.event(
      'issue-problem-changed',
      {
        issue: issue.number,
        before: digest({ title: issue.title, body: issue.currentBody ?? issue.originalBody }),
        after: digest({ title: updated.title, body: updated.currentBody }),
      },
      true,
    );
    return updated;
  }

  private authoredBody(issue: DeliveryIssue, section: string): string {
    const content = [
      ...(issue.title !== (issue.originalTitle ?? issue.title) ||
      (issue.currentBody ?? issue.originalBody) !== issue.originalBody
        ? [
            '## Original issue evidence',
            `Original title: ${issue.originalTitle ?? issue.title}`,
            issue.originalBody,
          ]
        : []),
      ...(issue.acceptance.length === 0
        ? []
        : [
            '## Current acceptance',
            ...issue.acceptance.map(
              (criterion) =>
                `- ${criterion.id}: ${criterion.outcome}\n  Evidence: ${criterion.evidence.join('; ')}`,
            ),
          ]),
      ...(issue.decisions.length === 0
        ? []
        : ['## Mandate-authorized decisions', ...issue.decisions]),
      section,
    ].join('\n\n');
    const suffix = `\n\n<!-- agent-quorum-delivery-status:${contentDigest(content)} -->\n${content}\n<!-- /agent-quorum-delivery-status -->`;
    const authored =
      this.ledger.get<{ suffix: string; digest: string }[]>(
        `authored-body-blocks:${issue.number}`,
      ) ?? [];
    if (!authored.some((block) => block.suffix === suffix)) {
      this.ledger.set(`authored-body-blocks:${issue.number}`, [
        ...authored,
        { suffix, digest: contentDigest(suffix) },
      ]);
    }
    return `${issue.currentBody ?? issue.originalBody}${suffix}`;
  }

  private async designInputDigest(issue: DeliveryIssue): Promise<string> {
    return digest({
      title: issue.title,
      originalTitle: issue.originalTitle ?? issue.title,
      body: issue.currentBody ?? issue.originalBody,
      originalBody: issue.originalBody,
      acceptance: issue.acceptance,
      decisions: issue.decisions,
      base: issue.baseSha,
      profile: this.mandate.profileDigest,
      tree: await this.services.repository.treeDigest(requireWorktree(issue), issue.number),
    });
  }

  private async defer(
    issue: DeliveryIssue,
    blocker: string,
    reconsiderWhen: string,
  ): Promise<void> {
    if (issue.stage !== 'recover' && issue.stage !== 'deferred') {
      this.ledger.set(`resume-stage:${issue.number}`, issue.stage);
    }
    this.ledger.set(
      `recover-implementation:${issue.number}`,
      this.ledger
        .effects()
        .some(
          (effect) =>
            effect.issue === issue.number &&
            (effect.state === 'unknown' || effect.state === 'intended'),
        ),
    );
    this.save({ ...issue, stage: 'deferred', blocker, reconsiderWhen });
    this.ledger.set(`pending-status:${issue.number}`, { blocker, reconsiderWhen });
    this.ledger.event('issue-deferred', { issue: issue.number, blocker, reconsiderWhen }, true);
    if (
      this.ledger.mode() === 'active' &&
      this.ledger.budget(issue.number, this.services.now()).availableMs > 0
    ) {
      try {
        await this.reconcileDeferredStatus(issue);
      } catch {
        this.ledger.event(
          'backlog-reconciliation-pending',
          { issue: issue.number, blocker: 'deferred-status-not-confirmed' },
          true,
        );
      }
    }
  }

  private async reconcileDeferredStatus(issue: DeliveryIssue): Promise<void> {
    const pending = this.ledger.get<{ blocker: string; reconsiderWhen: string }>(
      `pending-status:${issue.number}`,
    );
    if (pending === undefined) {
      return;
    }
    await this.actualize(
      issue,
      this.authoredBody(
        issue,
        `## Delivery status\n\nDeferred: ${pending.blocker}. ${pending.reconsiderWhen}\n\n${issue.pullRequest === undefined ? 'No merged implementation is claimed.' : `Partial progress: PR #${issue.pullRequest}; no completed delivery is claimed.`}\n\nDependencies: ${issue.dependencies.map((number) => `#${number}`).join(', ') || 'none recorded'}.`,
      ),
    );
    await this.project(issue, 'deferred');
    this.ledger.unset(`pending-status:${issue.number}`);
  }

  private async choose(): Promise<DeliveryStepResult> {
    const github = this.services.github;
    const queued = this.ledger
      .issues()
      .find(
        (candidate) =>
          candidate.stage === 'deferred' &&
          this.ledger.get<IssueStage>(`queued-reopen:${candidate.number}`) !== undefined &&
          scopeIncludes(this.mandate.profile.scope, candidate.number),
      );
    if (queued !== undefined) {
      const stage = this.ledger.get<IssueStage>(`queued-reopen:${queued.number}`) ?? 'refine';
      const current = this.observeProblem(queued, await github.getIssue(queued.number));
      this.ledger.unset(`queued-reopen:${queued.number}`);
      this.save({ ...current, stage: current === queued ? stage : 'refine' });
      return { waitMs: 0 };
    }
    const baseSha = await github.getMain();
    if (
      assessRequiredChecks(baseSha, this.mandate.requiredChecks, await github.getChecks(baseSha))
        .length > 0
    ) {
      throw new DeliveryError('main-required-checks-unhealthy', true);
    }
    const [issues, pulls, sessions] = await Promise.all([
      github.listIssues(),
      github.listPullRequests(),
      foreignSessions(this.ledger, this.services.repository),
    ]);
    const ready: GitHubIssue[] = [];
    for (const issue of issues) {
      if (!scopeIncludes(this.mandate.profile.scope, issue.number)) {
        continue;
      }
      const prior = this.ledger.issue(issue.number);
      const fingerprint = digest({ issue, baseSha });
      const resolvedPrerequisites =
        prior?.stage === 'deferred' &&
        prior.dependencies.length > 0 &&
        !(await this.hasOpenDependencies(prior));
      const pendingPlan = this.ledger.get<DesignAttempt>(`design-pending:${issue.number}`);
      const changedPlanInputs =
        prior?.stage === 'deferred' &&
        pendingPlan?.state === 'terminal' &&
        pendingPlan.inputDigest !== (await this.designInputDigest(prior));
      if (
        prior?.stage === 'done' ||
        (prior?.stage === 'deferred' &&
          ((!resolvedPrerequisites &&
            !changedPlanInputs &&
            (this.ledger.get<string>(`last-considered:${issue.number}`) ?? prior.fingerprint) ===
              fingerprint) ||
            /limit|uncertain/.test(prior.blocker ?? '')))
      ) {
        continue;
      }
      if (
        prior?.stage === 'deferred' &&
        !this.problemChanged(prior, issue) &&
        !resolvedPrerequisites &&
        prior.baseSha === baseSha
      ) {
        if (
          this.ledger.get(`pending-status:${issue.number}`) !== undefined ||
          (pendingPlan?.state === 'terminal' && !changedPlanInputs)
        ) {
          continue;
        }
      }
      if (sessions.some((session) => session.ambiguous || session.issues.includes(issue.number))) {
        this.ledger.event('issue-ineligible', {
          issue: issue.number,
          reason: 'foreign-session-ownership',
          worktrees: sessions
            .filter((session) => session.ambiguous || session.issues.includes(issue.number))
            .map((session) => session.worktree),
        });
        continue;
      }
      if (
        issue.assignees.some((assignee) => assignee !== this.mandate.actor) ||
        pulls.some(
          (pull) =>
            matchesIssue(pull.body, issue.number) &&
            pull.number !== prior?.pullRequest &&
            pull.headRef !== prior?.branch,
        )
      ) {
        this.ledger.event('issue-ineligible', {
          issue: issue.number,
          reason: 'existing-owner-or-pull-request',
        });
        continue;
      }
      const dependencies = await github.getDependencies(issue.number);
      if (dependencies.some((dependency) => dependency.state !== 'closed')) {
        this.ledger.event('issue-ineligible', {
          issue: issue.number,
          reason: 'open-prerequisite',
          dependencies: dependencies.map((dependency) => dependency.number),
        });
        continue;
      }
      if (
        /^(?:release(?:\s+v?\d|:)|publish\b|bump\s+(?:release\s+)?version)/i.test(issue.title) ||
        issue.labels.includes('release-only')
      ) {
        this.ledger.event(
          'release-deferred',
          { issue: issue.number, reason: 'manual-release-ownership' },
          true,
        );
        continue;
      }
      ready.push(issue);
    }
    ready.sort((left, right) => priority(left, this.mandate) - priority(right, this.mandate));
    const selected = ready[0];
    if (selected === undefined) {
      const pending = this.ledger
        .issues()
        .find(
          (candidate) =>
            candidate.stage === 'deferred' &&
            scopeIncludes(this.mandate.profile.scope, candidate.number) &&
            this.services.now() -
              (this.ledger.get<number>(`last-recovery:${candidate.number}`) ?? 0) >=
              CI_WAIT_MS &&
            (this.ledger.get(`pending-status:${candidate.number}`) !== undefined ||
              this.ledger
                .effects()
                .some(
                  (effect) =>
                    effect.issue === candidate.number &&
                    (effect.state === 'unknown' || effect.state === 'intended'),
                )),
        );
      if (
        pending !== undefined &&
        this.ledger.budget(pending.number, this.services.now()).availableMs > 0
      ) {
        this.save({ ...pending, stage: 'recover' });
        return { waitMs: 0 };
      }
      return { waitMs: IDLE_WAIT_MS };
    }
    const preserved = this.ledger.issue(selected.number);
    if (preserved !== undefined) {
      const current = this.observeProblem(preserved, selected);
      const resumeStage =
        this.ledger.get<IssueStage>(`resume-stage:${selected.number}`) ?? 'refine';
      this.save({
        ...current,
        fingerprint: digest({ issue: selected, baseSha }),
        stage:
          current !== preserved ||
          current.baseSha !== baseSha ||
          resumeStage === 'deferred' ||
          resumeStage === 'recover'
            ? 'refine'
            : resumeStage,
      });
      this.ledger.event(
        'issue-reconsidered',
        {
          issue: selected.number,
          baseSha,
          priorBlocker: preserved.blocker,
          preservedWorktree: preserved.worktree,
        },
        true,
      );
      return { waitMs: 0 };
    }
    this.save({
      number: selected.number,
      nodeId: selected.nodeId,
      title: selected.title,
      originalTitle: selected.title,
      originalBody: selected.body,
      currentBody: selected.body,
      fingerprint: digest({ issue: selected, baseSha }),
      stage: 'refine',
      baseSha,
      acceptance: [],
      decisions: [],
      dependencies: [],
      findingKeys: [],
    });
    this.ledger.event('issue-selected', {
      issue: selected.number,
      baseSha,
      rank: priority(selected, this.mandate),
      readyAlternatives: ready.slice(1).map((issue) => issue.number),
      rationale:
        'Operator order, correctness blockers, delivery reliability, ready improvements, then issue age.',
    });
    return { waitMs: 0 };
  }

  private prompt(issue: DeliveryIssue, instruction: string): string {
    return JSON.stringify({
      instruction,
      repository: this.mandate.repository,
      issue,
      currentProblem: { title: issue.title, body: issue.currentBody ?? issue.originalBody },
      originalEvidence: { title: issue.originalTitle ?? issue.title, body: issue.originalBody },
      authority: {
        productDecisions: true,
        incompatibleContracts: true,
        releases: false,
        mutations: 'controller-only',
      },
      previousFeedback: issue.feedback ?? '',
      plan:
        issue.designWorkDir === undefined
          ? null
          : readFileSync(path.join(issue.designWorkDir, 'plan.final.md'), 'utf8'),
    });
  }

  private async work(
    issue: DeliveryIssue,
    instruction: string,
  ): Promise<WorkerAnswer<WorkerResult>> {
    this.ledger.assertAuthorized('edit', issue.number);
    const prompt = this.prompt(issue, instruction);
    const inputDigest = digest({
      prompt,
      candidate: await this.services.repository.treeDigest(requireWorktree(issue), issue.number),
      profile: this.mandate.profileDigest,
      verificationGeneration:
        this.ledger.get<number>(`verification-generation:${issue.number}`) ?? 0,
    });
    const cacheKey = `worker-result:${issue.number}:${inputDigest}`;
    const retained = this.ledger.get<WorkerAnswer<WorkerResult>>(cacheKey);
    if (retained !== undefined) {
      this.ledger.set(`implementation-invocation:${issue.number}`, retained.invocationId);
      return retained;
    }
    const identity = `${issue.stage}-${randomUUID()}`;
    const input: WorkerCall = {
      issue: issue.number,
      cwd: requireWorktree(issue),
      prompt,
      outputFile: issueArtifact(this.ledger, issue.number, `${identity}.json`),
      execution: this.execution,
    };
    this.ledger.event('worker-dispatched', {
      issue: issue.number,
      stage: issue.stage,
      outputFile: input.outputFile,
      inputDigest: contentDigest(prompt),
    });
    const answer = await this.services.worker.work(input);
    this.ledger.set(cacheKey, answer);
    this.ledger.set(`implementation-invocation:${issue.number}`, answer.invocationId);
    return answer;
  }

  private async actualize(issue: DeliveryIssue, text: string): Promise<void> {
    const current = await this.services.github.getIssue(issue.number);
    if (this.observeProblem(issue, current) !== issue) {
      throw new DeliveryError('issue-problem-changed');
    }
    if (current.body === text) {
      this.ledger.set(
        `last-considered:${issue.number}`,
        digest({ issue: current, baseSha: issue.baseSha }),
      );
      return;
    }
    const key = `actualize:${issue.number}:${digest(text)}`;
    const effect: EffectRecord = {
      key,
      kind: 'issue',
      issue: issue.number,
      state: 'intended',
      input: { body: text },
    };
    const actualized = await externalEffect(
      this.ledger,
      effect,
      () => this.services.github.updateIssue(issue.number, { body: text }),
      async () => {
        const updated = await this.services.github.getIssue(issue.number);
        return updated.body === text ? updated : undefined;
      },
    );
    this.ledger.set(
      `last-considered:${issue.number}`,
      digest({ issue: actualized, baseSha: issue.baseSha }),
    );
  }

  private async capture(
    issue: DeliveryIssue,
    findings: readonly DeliveryFinding[],
  ): Promise<DeliveryIssue> {
    const keys = new Set(issue.findingKeys);
    const dependencies = new Set(issue.dependencies);
    for (const finding of findings) {
      this.ledger.event('finding-assessed', {
        issue: issue.number,
        kind: finding.kind,
        identity: digest(finding),
        evidenceCount: finding.evidence.length,
      });
      if (finding.kind === 'necessary' || finding.kind === 'observation') {
        continue;
      }
      if (finding.evidence.length === 0) {
        continue;
      }
      const identity = digest({
        problem: finding.problem.trim().toLowerCase(),
        outcome: finding.outcome.trim().toLowerCase(),
      });
      if (keys.has(identity)) {
        continue;
      }
      const allIssues = await this.services.github.listIssues('all');
      const match = allIssues.find(
        (candidate) =>
          candidate.number === finding.relatedIssue ||
          candidate.body.includes(`Finding-Identity: ${identity}`) ||
          candidate.title.trim().toLowerCase() === finding.title.trim().toLowerCase(),
      );
      const body = [
        finding.problem,
        '## Evidence',
        ...finding.evidence.map((evidence) => `- ${evidence}`),
        '## Expected outcome',
        finding.outcome,
        '## Relationship and uncertainty',
        `Discovered while delivering #${issue.number}. Classification: ${finding.kind}.`,
        finding.uncertainty || 'No additional uncertainty identified.',
        `Finding-Identity: ${identity}`,
      ].join('\n\n');
      let related: number;
      if (match !== undefined) {
        related = match.number;
        if (!match.body.includes(`Finding-Identity: ${identity}`)) {
          const key = `finding-update:${identity}:${match.number}`;
          const nextBody = `${match.body}\n\n${body}`;
          await externalEffect(
            this.ledger,
            {
              key,
              kind: 'issue',
              issue: issue.number,
              state: 'intended',
              input: { number: match.number, body: nextBody },
            },
            () => this.services.github.updateIssue(match.number, { body: nextBody }),
            async () => {
              const candidate = await this.services.github.getIssue(match.number);
              return candidate.body.includes(`Finding-Identity: ${identity}`)
                ? candidate
                : undefined;
            },
          );
        }
      } else {
        const key = `finding-create:${identity}`;
        const created = await externalEffect(
          this.ledger,
          {
            key,
            kind: 'issue',
            issue: issue.number,
            state: 'intended',
            input: { title: finding.title, body },
          },
          () => this.services.github.createIssue({ title: finding.title, body, operationKey: key }),
          async () => {
            const candidate = await this.services.github.reconcileCreation({
              kind: 'issue',
              operationKey: key,
            });
            return candidate.status === 'found'
              ? this.services.github.getIssue(candidate.number)
              : undefined;
          },
        );
        related = created.number;
      }
      if (finding.kind === 'prerequisite') {
        dependencies.add(related);
      }
      keys.add(identity);
      this.ledger.set(`linked-findings:${issue.number}`, [
        ...new Set([
          ...(this.ledger.get<number[]>(`linked-findings:${issue.number}`) ?? []),
          related,
        ]),
      ]);
      this.ledger.event('finding-linked', { issue: issue.number, related, kind: finding.kind });
    }
    return { ...issue, findingKeys: [...keys], dependencies: [...dependencies] };
  }

  private async recover(issue: DeliveryIssue): Promise<void> {
    let current = issue;
    this.ledger.set(`last-recovery:${issue.number}`, this.services.now());
    const resume = this.ledger.get<IssueStage>(`resume-stage:${issue.number}`) ?? 'refine';
    const resumesImplementation =
      this.ledger.get<boolean>(`recover-implementation:${issue.number}`) ?? true;
    try {
      current = await this.reconcileEffects(current);
      const remaining = this.ledger
        .effects()
        .filter(
          (effect) =>
            effect.issue === issue.number &&
            (effect.state === 'unknown' || effect.state === 'intended'),
        );
      if (remaining.length > 0) {
        this.save({
          ...current,
          stage: 'deferred',
          ...(resumesImplementation
            ? {
                blocker: 'uncertain-external-effect',
                reconsiderWhen:
                  'Await observed outcome of the recorded operation; an empty search does not establish failure.',
              }
            : {}),
        });
        return;
      }
      await this.reconcileDeferredStatus(current);
      if (!resumesImplementation) {
        this.save({ ...current, stage: 'deferred' });
        this.ledger.event('deferred-status-reconciled', {
          issue: issue.number,
          blocker: current.blocker,
        });
        return;
      }
      this.save({
        ...current,
        stage: resume === 'recover' || resume === 'deferred' ? 'refine' : resume,
      });
      this.ledger.event('issue-recovered', { issue: issue.number, resumed: resume }, true);
    } catch (error) {
      if (
        this.ledger.mode() !== 'active' ||
        this.execution.signal?.aborted === true ||
        (error instanceof DeliveryError && error.isShared)
      ) {
        throw error;
      }
      if (error instanceof DeliveryError && error.code === 'issue-problem-changed') {
        return;
      }
      this.save({ ...(this.ledger.issue(issue.number) ?? current), stage: 'deferred' });
      this.ledger.event('backlog-reconciliation-pending', {
        issue: issue.number,
        blocker: 'recovery-not-confirmed',
      });
    }
  }

  private async reconcileEffects(issue: DeliveryIssue): Promise<DeliveryIssue> {
    const branch = this.ledger.effects().find((effect) => {
      return (
        (effect.issue === issue.number && effect.kind === 'branch') ||
        effect.key.startsWith(`worktree:${issue.number}:`)
      );
    });
    if (branch !== undefined) {
      const owned = await this.services.repository.createWorktree(
        issue.number,
        issue.baseSha,
        branch.key,
      );
      issue = {
        ...issue,
        ...owned,
        baseSha: issue.worktree === undefined ? owned.baseSha : issue.baseSha,
      };
      this.save(issue);
    }
    const effects = this.ledger
      .effects()
      .filter(
        (effect) =>
          effect.issue === issue.number &&
          (effect.state === 'unknown' || effect.state === 'intended'),
      );
    for (const effect of effects) {
      this.ledger.assertAuthorized(effect.kind, issue.number);
      const input = effect.input as Record<string, unknown>;
      let outcome: unknown;
      if (effect.key.startsWith('finding-create:') || effect.key.startsWith('pull-request:')) {
        const kind = effect.kind === 'pull-request' ? 'pull-request' : 'issue';
        const found = await this.services.github.reconcileCreation({
          kind,
          operationKey: effect.key,
        });
        if (found.status === 'found') {
          outcome =
            kind === 'issue'
              ? await this.services.github.getIssue(found.number)
              : await this.services.github.getPullRequest(found.number);
        }
      } else if (effect.kind === 'edit' && issue.worktree !== undefined) {
        new EditBroker(this.ledger).apply(
          issue.number,
          issue.worktree,
          [],
          effect.key.slice(`edit:${issue.number}:`.length),
        );
        continue;
      } else if (effect.kind === 'merge' && typeof input.number === 'number') {
        const pull = await this.services.github.getPullRequest(input.number);
        if (pull.merged && pull.headSha === input.head && pull.mergeCommitSha !== null) {
          outcome = { sha: pull.mergeCommitSha, merged: true };
        }
      } else if (
        effect.kind === 'push' &&
        typeof input.branch === 'string' &&
        typeof input.sha === 'string'
      ) {
        const actual = await this.services.repository.git(
          requireWorktree(issue),
          ['ls-remote', 'origin', `refs/heads/${input.branch}`],
          issue.number,
        );
        if (actual.startsWith(input.sha)) {
          outcome = true;
        }
      } else if (
        effect.kind === 'pull-request' &&
        typeof input.number === 'number' &&
        typeof input.body === 'string'
      ) {
        const pull = await this.services.github.getPullRequest(input.number);
        if (pull.body.includes(input.body)) {
          outcome = pull;
        }
      } else if (effect.kind === 'project') {
        const mapping = projectMapping(this.mandate);
        if (mapping !== undefined) {
          const items = await this.services.github.listProjectItems(mapping);
          if (typeof input.nodeId === 'string') {
            outcome = items.find((item) => item.contentId === input.nodeId)?.id;
          } else if (
            typeof input.itemId === 'string' &&
            typeof input.status === 'string' &&
            items.some(
              (item) =>
                item.id === input.itemId &&
                item.statusOptionId === mapping.statusOptions[input.status as string],
            )
          ) {
            outcome = true;
          }
        }
      } else if (effect.kind === 'issue') {
        const current = await this.services.github.getIssue(
          typeof input.number === 'number' ? input.number : issue.number,
        );
        if (
          (typeof input.body === 'string' &&
            (effect.key.startsWith('actualize:')
              ? current.body === input.body
              : current.body.includes(input.body))) ||
          ((effect.key.startsWith('close-merged:') || effect.key.startsWith('prior-resolution:')) &&
            current.state === 'closed')
        ) {
          outcome = current;
        }
      } else if (effect.kind === 'commit' && issue.worktree !== undefined) {
        const marker = `Delivery-Operation: ${effect.key}`;
        const existing = await this.services.repository.git(
          issue.worktree,
          ['log', '--format=%H', '--fixed-strings', `--grep=${marker}`, '-1'],
          issue.number,
        );
        if (existing !== '') {
          outcome = { sha: existing };
        }
      }
      if (outcome !== undefined) {
        this.ledger.finishEffect(effect.key, 'completed', outcome);
      }
    }
    return issue;
  }

  private async hasOpenDependencies(issue: DeliveryIssue): Promise<boolean> {
    const dependencies = await Promise.all(
      issue.dependencies.map((number) => this.services.github.getIssue(number)),
    );
    return dependencies.some((dependency) => dependency.state !== 'closed');
  }

  private async project(issue: DeliveryIssue, status: ProjectStatus): Promise<void> {
    const mapping = projectMapping(this.mandate);
    if (mapping === undefined) {
      return;
    }
    const items = await this.services.github.listProjectItems(mapping);
    let item = items.find((candidate) => candidate.contentId === issue.nodeId);
    if (item === undefined) {
      const key = `project-add:${mapping.projectId}:${issue.nodeId}`;
      const added = await externalEffect(
        this.ledger,
        {
          key,
          kind: 'project',
          issue: issue.number,
          state: 'intended',
          input: { nodeId: issue.nodeId },
        },
        () => this.services.github.addProjectItem(mapping, issue.nodeId),
        async () =>
          (await this.services.github.listProjectItems(mapping)).find(
            (candidate) => candidate.contentId === issue.nodeId,
          )?.id,
      );
      item = { id: added, contentId: issue.nodeId, statusOptionId: null };
    }
    const transitionKey = `project-transition:${mapping.projectId}:${item.id}`;
    const previous = this.ledger.get<ProjectTransition>(transitionKey);
    let observedStatus = item.statusOptionId;
    if (previous !== undefined && this.ledger.effect(previous.key)?.state !== 'completed') {
      if (
        this.ledger.effect(previous.key) !== undefined &&
        observedStatus === mapping.statusOptions[previous.status]
      ) {
        this.ledger.finishEffect(previous.key, 'completed', true);
      } else {
        await this.applyProjectStatus(issue, mapping, item.id, previous);
        observedStatus = mapping.statusOptions[previous.status] ?? null;
      }
    }
    if (observedStatus === mapping.statusOptions[status]) {
      return;
    }
    const generation = (previous?.generation ?? 0) + 1;
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new DeliveryError('project-transition-limit');
    }
    const transition: ProjectTransition = {
      generation,
      key: `project-status:${mapping.projectId}:${item.id}:${generation}`,
      status,
    };
    this.ledger.set(transitionKey, transition);
    await this.applyProjectStatus(issue, mapping, item.id, transition);
  }

  private async applyProjectStatus(
    issue: DeliveryIssue,
    mapping: GitHubProjectMapping,
    itemId: string,
    transition: ProjectTransition,
  ): Promise<void> {
    const { key, status } = transition;
    await externalEffect(
      this.ledger,
      { key, kind: 'project', issue: issue.number, state: 'intended', input: { itemId, status } },
      async () => {
        await this.services.github.updateProjectItemStatus(mapping, itemId, status);
        return true;
      },
      async () =>
        (await this.services.github.listProjectItems(mapping)).some(
          (candidate) =>
            candidate.id === itemId && candidate.statusOptionId === mapping.statusOptions[status],
        )
          ? true
          : undefined,
    );
  }

  private async refine(issue: DeliveryIssue): Promise<void> {
    const currentMain = await this.services.github.getMain();
    const owned =
      issue.worktree === undefined
        ? await this.services.repository.createWorktree(issue.number, currentMain)
        : {
            worktree: issue.worktree,
            baseSha: issue.baseSha,
            ...(issue.branch === undefined ? {} : { branch: issue.branch }),
          };
    this.save({ ...issue, ...owned });
    if (owned.baseSha !== currentMain) {
      await this.services.repository.git(owned.worktree, ['fetch', 'origin', 'main'], issue.number);
      await this.services.repository.git(
        owned.worktree,
        ['merge', '--no-edit', currentMain],
        issue.number,
        true,
      );
    }
    const current = { ...issue, ...owned, baseSha: currentMain };
    this.save(current);
    const answer = await this.work(
      current,
      'Refine the current problem against current main, preserve the original evidence, define observable acceptance, and choose the shortest sufficient preparation route. Do not propose edits yet.',
    );
    const result = answer.result;
    let updated = await this.capture(current, result.findings);
    if (result.action === 'decomposed') {
      if (updated.findingKeys.length === 0 || result.rationale.trim() === '') {
        throw new DeliveryError('decomposition-without-linked-outcomes');
      }
      updated = {
        ...updated,
        acceptance: result.acceptance,
        decisions: result.decisions,
        dependencies: [
          ...new Set([
            ...updated.dependencies,
            ...(this.ledger.get<number[]>(`linked-findings:${issue.number}`) ?? []),
          ]),
        ],
      };
      await this.actualize(
        updated,
        this.authoredBody(
          updated,
          `## Decomposed work\n\n${result.rationale}\n\nIndependent outcomes retain the original problem. Linked finding identities: ${updated.findingKeys.join(', ')}.`,
        ),
      );
      await this.defer(
        updated,
        'decomposed-work',
        'Reconsider after linked independently deliverable outcomes are reconciled.',
      );
      return;
    }
    if (result.action === 'resolved' || result.action === 'duplicate') {
      if (
        result.rationale.trim() === '' ||
        result.acceptance.every((criterion) => criterion.evidence.length === 0) ||
        (result.action === 'duplicate' && result.relatedIssue === null)
      ) {
        throw new DeliveryError('resolution-without-supporting-evidence');
      }
      await this.actualize(
        updated,
        this.authoredBody(
          updated,
          `## Evidence-backed ${result.action}\n\n${result.rationale}\n\n${JSON.stringify(result.acceptance)}${result.relatedIssue === null ? '' : `\n\nDuplicate of #${result.relatedIssue}.`}`,
        ),
      );
      const reason = result.action === 'duplicate' ? 'not_planned' : 'completed';
      const key = `prior-resolution:${issue.number}:${digest(result)}`;
      await externalEffect(
        this.ledger,
        { key, kind: 'issue', issue: issue.number, state: 'intended', input: { reason } },
        () => this.services.github.closeIssue(issue.number, reason),
        async () => {
          const existing = await this.services.github.getIssue(issue.number);
          return existing.state === 'closed' ? existing : undefined;
        },
      );
      this.save({ ...updated, stage: 'done', decisions: [result.rationale] });
      this.ledger.event(
        'prior-resolution',
        { issue: issue.number, disposition: result.action, related: result.relatedIssue },
        true,
      );
      return;
    }
    if (result.action === 'blocked') {
      await this.defer(updated, 'issue-input-unavailable', result.rationale);
      return;
    }
    if (result.action !== 'refined' || result.acceptance.length === 0) {
      throw new DeliveryError('invalid-refinement-outcome');
    }
    updated = {
      ...updated,
      acceptance: result.acceptance,
      decisions: result.decisions,
      dependencies: [...new Set([...updated.dependencies, ...result.dependencies])],
    };
    await this.actualize(updated, this.authoredBody(updated, result.rationale));
    await this.project(updated, 'active');
    if (
      updated.dependencies.length > 0 &&
      (
        await Promise.all(
          updated.dependencies.map((number) => this.services.github.getIssue(number)),
        )
      ).some((dependency) => dependency.state !== 'closed')
    ) {
      await this.defer(
        updated,
        'blocking-prerequisite',
        `Reconsider after ${updated.dependencies.map((number) => `#${number}`).join(', ')} is resolved.`,
      );
      return;
    }
    this.save({ ...updated, stage: result.requiresPlan ? 'plan' : 'implement' });
  }

  private async plan(issue: DeliveryIssue): Promise<void> {
    const inputDigest = await this.designInputDigest(issue);
    let pending = this.ledger.get<DesignAttempt>(`design-pending:${issue.number}`);
    if (pending?.inputDigest !== inputDigest || pending.state === 'terminal') {
      const reservation = this.ledger.get<{ inputDigest: string; identity: string }>(
        `design-reservation:${issue.number}`,
      );
      const identity =
        reservation?.inputDigest === inputDigest
          ? reservation.identity
          : `design:${issue.number}:${randomUUID()}`;
      this.ledger.set(`design-reservation:${issue.number}`, { inputDigest, identity });
      const attempt = this.ledger.reserveAttempt(
        issue.number,
        'design',
        this.mandate.profile.planning.maxRuns,
        identity,
      );
      pending = {
        inputDigest,
        output: path.join(this.ledger.directory, 'design', `${issue.number}-${attempt}`),
        identity,
        state: 'pending',
      };
      this.ledger.transaction(() => {
        this.ledger.set(`design-pending:${issue.number}`, pending);
        this.ledger.set(`design-attempt:${identity}`, pending);
        this.ledger.unset(`design-reservation:${issue.number}`);
      });
    }
    let plan: DeliveryPlanResult;
    try {
      plan = await this.services.plan(issue, pending.output);
    } catch (error) {
      if (
        this.ledger.mode() === 'active' &&
        this.execution.signal?.aborted !== true &&
        !(error instanceof ExecutionControlError && error.reason === 'aborted') &&
        !(error instanceof DeliveryError && error.isShared)
      ) {
        const failed = { ...pending, state: 'terminal' as const };
        this.ledger.set(`design-pending:${issue.number}`, failed);
        this.ledger.set(`design-attempt:${pending.identity}`, failed);
      }
      throw error;
    }
    this.save({ ...issue, designWorkDir: plan.workDir, stage: 'implement' });
  }

  private async implement(issue: DeliveryIssue): Promise<void> {
    const installation = await this.services.repository.verify(
      requireWorktree(issue),
      ['install', '--frozen-lockfile', '--offline', '--ignore-scripts'],
      issue.number,
    );
    if (installation.exitCode !== 0) {
      throw new DeliveryError('offline-dependencies-unavailable');
    }
    const answer = await this.work(
      issue,
      'Implement the current acceptance with compact digest-bound edit batches. Use the admitted plan if present. Before ready, complete a bounded behavior-preserving refactor pass, then tidy; include justified related consumers, preserve contracts, and avoid repeated polish. Record the useful improvements or no-change outcome in rationale. Return ready only when the work is ready for verification and independent review.',
    );
    const result = answer.result;
    const updated = await this.capture(issue, result.findings);
    if (await this.hasOpenDependencies(updated)) {
      await this.defer(
        updated,
        'blocking-prerequisite',
        `Await resolved dependencies: ${updated.dependencies.join(', ')}.`,
      );
      return;
    }
    if (result.action === 'blocked') {
      await this.defer(updated, 'implementation-blocked', result.rationale);
      return;
    }
    if (result.action === 'edit') {
      if (result.edits.length === 0) {
        throw new DeliveryError('empty-implementation-edit');
      }
      new EditBroker(this.ledger).apply(issue.number, requireWorktree(issue), result.edits);
      for (const operation of result.packageOperations ?? []) {
        const refresh = await this.services.repository.verify(
          requireWorktree(issue),
          ['install', '--lockfile-only', '--offline', '--ignore-scripts'],
          issue.number,
        );
        if (refresh.exitCode !== 0) {
          this.save({
            ...updated,
            feedback: JSON.stringify({
              operation,
              output: (refresh.stdout + refresh.stderr).slice(-50_000),
            }),
          });
          return;
        }
      }
      for (const test of result.targetedTests) {
        const verification = await this.services.repository.verify(
          requireWorktree(issue),
          ['run', 'test', test],
          issue.number,
        );
        this.ledger.set(`targeted-feedback:${issue.number}`, {
          test,
          exitCode: verification.exitCode,
          outputDigest: contentDigest(verification.stdout + verification.stderr),
          output: (verification.stdout + verification.stderr).slice(-50_000),
        });
      }
      this.save({
        ...updated,
        feedback: JSON.stringify(this.ledger.get(`targeted-feedback:${issue.number}`) ?? null),
      });
      return;
    }
    if (result.action !== 'ready') {
      throw new DeliveryError('invalid-implementation-outcome');
    }
    this.ledger.set(`live-uncertainty:${issue.number}`, result.uncertainty);
    this.save({ ...updated, stage: 'verify' });
  }

  private async verify(issue: DeliveryIssue): Promise<void> {
    const worktree = requireWorktree(issue);
    const before = await this.services.repository.treeDigest(worktree, issue.number);
    const checks = [];
    let stable = true;
    for (const script of ['check', 'test']) {
      const result = await this.services.repository.verify(worktree, ['run', script], issue.number);
      checks.push({
        command: ['pnpm', 'run', script],
        exitCode: result.exitCode,
        outputDigest: contentDigest(result.stdout + result.stderr),
      });
      stable =
        stable && (await this.services.repository.treeDigest(worktree, issue.number)) === before;
      if (result.exitCode !== 0) {
        this.ledger.set(
          `verification-generation:${issue.number}`,
          (this.ledger.get<number>(`verification-generation:${issue.number}`) ?? 0) + 1,
        );
        const logPath = issueArtifact(
          this.ledger,
          issue.number,
          `verification-${randomUUID()}.log`,
        );
        writeFileSync(logPath, result.stdout + result.stderr, { mode: 0o600 });
        if (this.ledger.get<ReviewReceipt>(`review:${issue.number}`) !== undefined) {
          this.beginRepair(
            issue.number,
            `verification:${this.ledger.get<ReviewReceipt>(`review:${issue.number}`)?.invocationId ?? 'missing'}`,
          );
        }
        this.save({
          ...issue,
          stage: 'implement',
          feedback: JSON.stringify({
            command: ['pnpm', 'run', script],
            output: (result.stdout + result.stderr).slice(-100_000),
            evidence: logPath,
          }),
        });
        return;
      }
    }
    const candidate = await this.services.repository.treeDigest(worktree, issue.number);
    if (!stable || candidate !== before) {
      this.ledger.event('verification-inputs-settling', {
        issue: issue.number,
        before,
        after: candidate,
      });
      return;
    }
    const receipt: VerificationReceipt = {
      candidate,
      inputsDigest: candidate,
      policyDigest: this.mandate.controllerDigest,
      checks,
    };
    this.ledger.set(`verification:${issue.number}`, receipt);
    this.save({ ...issue, stage: 'review' });
  }

  private async review(issue: DeliveryIssue): Promise<void> {
    const worktree = requireWorktree(issue);
    const candidate = await this.services.repository.treeDigest(worktree, issue.number);
    const previous = this.ledger.get<ReviewReceipt>(`review:${issue.number}`);
    const trackedDiff = await this.services.repository.git(
      worktree,
      ['diff', issue.baseSha, '--'],
      issue.number,
    );
    const untrackedPaths = (
      await this.services.repository.git(
        worktree,
        ['ls-files', '--others', '--exclude-standard', '-z'],
        issue.number,
      )
    )
      .split('\0')
      .filter(Boolean);
    const untracked = untrackedPaths.map((file) => {
      const target = path.join(worktree, file);
      const metadata = lstatSync(target);
      return {
        path: file,
        mode: metadata.mode & 0o777,
        content: metadata.isSymbolicLink() ? readlinkSync(target) : readFileSync(target, 'utf8'),
      };
    });
    const diff = JSON.stringify({ trackedDiff, untracked });
    const live = this.ledger.get<LiveReceipt>(`live:${issue.number}`);
    const liveCandidate = this.ledger.get<string>(`live-candidate-sha:${issue.number}`);
    const interveningDiff =
      liveCandidate === undefined
        ? ''
        : await this.services.repository.git(worktree, ['diff', liveCandidate, '--'], issue.number);
    const answer = await this.services.worker.review({
      issue: issue.number,
      cwd: worktree,
      outputFile: issueArtifact(this.ledger, issue.number, `review-${randomUUID()}.json`),
      execution: this.execution,
      prompt: JSON.stringify({
        issue,
        candidate,
        diff,
        diffDigest: contentDigest(diff),
        previous,
        live,
        interveningDiff,
        interveningDiffDigest: contentDigest(interveningDiff),
        verification: this.ledger.get(`verification:${issue.number}`),
      }),
    });
    const receipt: ReviewReceipt = {
      ...answer.result,
      invocationId: answer.invocationId,
      implementationInvocationId:
        this.ledger.get<string>(`implementation-invocation:${issue.number}`) ?? '',
      candidate,
      acceptanceDigest: digest(issue.acceptance),
    };
    this.ledger.set(`review:${issue.number}`, receipt);
    this.ledger.unset(`repair-active:${issue.number}`);
    const updated = await this.capture(issue, receipt.adjacentFindings);
    if (await this.hasOpenDependencies(updated)) {
      await this.defer(
        updated,
        'blocking-prerequisite',
        `Await resolved dependencies: ${updated.dependencies.join(', ')}.`,
      );
      return;
    }
    try {
      admitReview(receipt, candidate, issue.acceptance);
    } catch (error) {
      if (!(error instanceof DeliveryError)) {
        throw error;
      }
      this.beginRepair(issue.number, `review:${receipt.invocationId}`);
      this.save({ ...updated, stage: 'implement', feedback: JSON.stringify(receipt.findings) });
      return;
    }
    this.save({ ...updated, stage: 'commit' });
  }

  private async assertCandidateExclusions(issue: DeliveryIssue): Promise<void> {
    const worktree = requireWorktree(issue);
    const basePackage = await this.services.repository.git(
      worktree,
      ['show', `${issue.baseSha}:package.json`],
      issue.number,
    );
    if (basePackage !== '') {
      const currentPackage = readFileSync(path.join(worktree, 'package.json'), 'utf8');
      assertNoReleaseEdit('package.json', basePackage, currentPackage);
    }
    const paths = await this.services.repository.changedPaths(
      worktree,
      issue.baseSha,
      issue.number,
    );
    if (paths.some((file) => file.startsWith('.github/'))) {
      throw new DeliveryError('frozen-github-producer-change-excluded');
    }
  }

  private async commit(issue: DeliveryIssue): Promise<void> {
    await this.assertCandidateExclusions(issue);
    const worktree = requireWorktree(issue);
    const before = await this.services.repository.treeDigest(worktree, issue.number);
    this.admitLocal(issue, before);
    const changes = await this.services.repository.git(
      worktree,
      ['status', '--porcelain'],
      issue.number,
    );
    const sha =
      changes === ''
        ? await this.services.repository.git(worktree, ['rev-parse', 'HEAD'], issue.number)
        : await this.services.repository.commit(
            worktree,
            issue.number,
            `fix: deliver issue ${issue.number}`,
            before,
          );
    const after = await this.services.repository.treeDigest(worktree, issue.number);
    await this.assertCandidateExclusions(issue);
    this.save({ ...issue, candidateSha: sha, stage: after === before ? 'live' : 'verify' });
  }

  private admitLocal(issue: DeliveryIssue, candidate: string): ReviewReceipt {
    const verification = this.ledger.get<VerificationReceipt>(`verification:${issue.number}`);
    const review = this.ledger.get<ReviewReceipt>(`review:${issue.number}`);
    if (verification === undefined || review === undefined) {
      throw new DeliveryError('local-delivery-evidence-missing');
    }
    admitVerification(verification, candidate, candidate, this.mandate.controllerDigest, true);
    admitReview(review, candidate, issue.acceptance);
    return review;
  }

  private async adoptDecoder(issue: DeliveryIssue, implementation: string): Promise<void> {
    const proposal = readEvidenceDecoderProposal(requireWorktree(issue));
    if (proposal === undefined) {
      return;
    }
    const context = planningDecoderContext(this.mandate, this.ledger.directory, implementation);
    if (readApprovedEvidenceDecoder(context) !== undefined) {
      return;
    }
    const candidate = await this.services.repository.treeDigest(
      requireWorktree(issue),
      issue.number,
    );
    const criteria = evidenceDecoderAcceptance(
      proposal.decoderDigest,
      proposal.fixtureSetDigest,
      this.mandate.controllerDigest,
    );
    this.ledger.assertAuthorized('review', issue.number);
    const answer = await this.services.worker.review({
      issue: issue.number,
      cwd: requireWorktree(issue),
      execution: this.execution,
      outputFile: issueArtifact(this.ledger, issue.number, `decoder-review-${randomUUID()}.json`),
      prompt: JSON.stringify({
        instruction:
          'Independently review the decoder bytes, authentic positive and adversarial fixtures, and unchanged or stronger assurance semantics. Reject weakening of active policy. This review has distinct acceptance criteria from implementation review.',
        candidate,
        acceptance: criteria,
        decoder: readFileSync(proposal.decoderFile, 'utf8'),
        fixtures: proposal.fixtures,
      }),
    });
    const review: ReviewReceipt = {
      ...answer.result,
      invocationId: answer.invocationId,
      implementationInvocationId:
        this.ledger.get<string>(`implementation-invocation:${issue.number}`) ?? '',
      candidate,
      acceptanceDigest: digest(criteria),
    };
    admitReview(review, candidate, criteria);
    await adoptReviewedEvidenceDecoder({
      ...context,
      reviewCandidate: candidate,
      proposal,
      independentReview: review,
      execution: this.execution,
    });
    this.ledger.event('evidence-decoder-admitted', {
      issue: issue.number,
      producerRevision: implementation,
      decoderDigest: proposal.decoderDigest,
      fixtureSetDigest: proposal.fixtureSetDigest,
      review: review.invocationId,
    });
  }

  private async liveInputs(issue: DeliveryIssue): Promise<string> {
    const worktree = requireWorktree(issue);
    const files = (await this.services.repository.git(worktree, ['ls-files', '-z'], issue.number))
      .split('\0')
      .filter(Boolean)
      .sort();
    const inputs = files
      .filter((file) => !isLiveReuseEligible([file]))
      .map((file) => {
        const target = path.join(worktree, file);
        const metadata = lstatSync(target, { throwIfNoEntry: false });
        return {
          path: file,
          mode: metadata === undefined ? null : metadata.mode & 0o777,
          sha256:
            metadata === undefined
              ? null
              : contentDigest(
                  metadata.isSymbolicLink() ? readlinkSync(target) : readFileSync(target),
                ),
        };
      });
    return digest({
      inputs,
      profile: this.mandate.profileDigest,
      controller: this.mandate.controllerDigest,
    });
  }

  private async live(issue: DeliveryIssue): Promise<void> {
    const worktree = requireWorktree(issue);
    const paths = await this.services.repository.changedPaths(
      worktree,
      issue.baseSha,
      issue.number,
    );
    const uncertainty = this.ledger.get<string>(`live-uncertainty:${issue.number}`) ?? '';
    if (!needsLiveGate(paths, uncertainty)) {
      this.save({ ...issue, stage: 'pull-request' });
      return;
    }
    const candidate = await this.services.repository.treeDigest(worktree, issue.number);
    const expectedInputs = await this.liveInputs(issue);
    const previous = this.ledger.get<LiveReceipt>(`live:${issue.number}`);
    if (previous?.inputDigest === expectedInputs) {
      let applicable = previous;
      if (previous.candidate !== candidate) {
        const previousSha = this.ledger.get<string>(`live-candidate-sha:${issue.number}`);
        if (previousSha === undefined) {
          throw new DeliveryError('live-tested-candidate-identity-missing');
        }
        const interveningPaths = await this.services.repository.changedPaths(
          worktree,
          previousSha,
          issue.number,
        );
        if (!isLiveReuseEligible(interveningPaths)) {
          throw new DeliveryError('live-applicability-inputs-changed');
        }
        const diff = await this.services.repository.git(
          worktree,
          ['diff', previousSha, '--'],
          issue.number,
        );
        const review = this.admitLocal(issue, candidate);
        applicable = {
          ...previous,
          applicabilityDiffDigest: contentDigest(diff),
          reviewerInvocationId: review.invocationId,
        };
      }
      admitLiveReceipt(applicable, candidate, expectedInputs, this.admitLocal(issue, candidate));
      this.ledger.set(`live:${issue.number}`, applicable);
      this.save({ ...issue, stage: 'pull-request' });
      return;
    }
    if (issue.candidateSha === undefined) {
      throw new DeliveryError('live-implementation-revision-missing');
    }
    let implementation = this.ledger.get<string>(`live-implementation:${issue.number}`);
    const priorInputs = this.ledger.get<string>(`live-run-inputs:${issue.number}`);
    if (
      implementation === undefined ||
      (priorInputs !== undefined && priorInputs !== expectedInputs)
    ) {
      implementation = issue.candidateSha;
      this.ledger.set(`live-implementation:${issue.number}`, implementation);
      this.ledger.set(
        `live-run-generation:${issue.number}`,
        (this.ledger.get<number>(`live-run-generation:${issue.number}`) ?? 0) + 1,
      );
    }
    await this.adoptDecoder(issue, implementation);
    const manifestPath = path.join(worktree, 'benchmarks/planning/smoke-manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
    if (manifest.workspaceRevision !== implementation) {
      this.ledger.assertAuthorized('edit', issue.number);
      manifest.workspaceRevision = implementation;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      const sha = await this.services.repository.commit(
        worktree,
        issue.number,
        'chore(benchmark): pin delivery smoke revision',
        `manifest:${implementation}`,
      );
      issue = { ...issue, candidateSha: sha };
      this.save(issue);
    }
    const inputDigest = await this.liveInputs(issue);
    this.ledger.set(`live-run-inputs:${issue.number}`, inputDigest);
    const outputDir = path.join(this.ledger.directory, 'live', String(issue.number));
    this.ledger.event('live-gate-selected', {
      issue: issue.number,
      paths,
      hasMaterialUncertainty: uncertainty !== '',
      uncertaintyDigest: contentDigest(uncertainty),
      scenarios: REQUIRED_LIVE_SCENARIOS,
      outputDir,
    });
    await this.services.live(issue, outputDir, this.execution);
    const currentCandidate = await this.services.repository.treeDigest(worktree, issue.number);
    if (inputDigest !== (await this.liveInputs(issue))) {
      throw new DeliveryError('live-inputs-changed-during-run');
    }
    const receipt: LiveReceipt = {
      testedRevision: implementation,
      candidate: currentCandidate,
      inputDigest,
      outputDir,
      passedScenarios: REQUIRED_LIVE_SCENARIOS,
      applicabilityDiffDigest: '',
      reviewerInvocationId: '',
    };
    this.ledger.set(`live:${issue.number}`, receipt);
    this.ledger.set(`live-candidate-sha:${issue.number}`, issue.candidateSha);
    this.save({ ...issue, stage: 'verify' });
  }

  private async pullRequest(issue: DeliveryIssue): Promise<void> {
    await this.assertCandidateExclusions(issue);
    const worktree = requireWorktree(issue);
    this.admitLocal(issue, await this.services.repository.treeDigest(worktree, issue.number));
    if (issue.branch === undefined || issue.candidateSha === undefined) {
      throw new DeliveryError('candidate-branch-missing');
    }
    const branch = issue.branch;
    this.ledger.assertAuthorized('push', issue.number);
    const pushKey = `push:${branch}:${issue.candidateSha}`;
    await externalEffect(
      this.ledger,
      {
        key: pushKey,
        kind: 'push',
        issue: issue.number,
        state: 'intended',
        input: { branch, sha: issue.candidateSha },
      },
      async () => {
        await this.services.repository.git(
          worktree,
          ['push', 'origin', `HEAD:refs/heads/${branch}`],
          issue.number,
          true,
        );
        return true;
      },
      async () =>
        (
          await this.services.repository.git(
            worktree,
            ['ls-remote', 'origin', `refs/heads/${branch}`],
            issue.number,
          )
        ).startsWith(issue.candidateSha ?? 'missing')
          ? true
          : undefined,
    );
    const body = [
      `Closes #${issue.number}`,
      '## Outcome',
      ...issue.acceptance.map((criterion) => `- ${criterion.outcome}`),
      '## Verification',
      `Candidate: ${issue.candidateSha}`,
      'Local check and tests passed; independent review admitted.',
      `Evidence identity: ${digest({ review: this.ledger.get(`review:${issue.number}`), verification: this.ledger.get(`verification:${issue.number}`), live: this.ledger.get(`live:${issue.number}`) })}`,
    ].join('\n\n');
    let number = issue.pullRequest;
    if (number === undefined) {
      const key = `pull-request:${branch}`;
      const created = await externalEffect(
        this.ledger,
        {
          key,
          kind: 'pull-request',
          issue: issue.number,
          state: 'intended',
          input: { branch, title: issue.title },
        },
        () =>
          this.services.github.createPullRequest({
            title: issue.title,
            body,
            head: branch,
            operationKey: key,
          }),
        async () => {
          const recovered = await this.services.github.reconcileCreation({
            kind: 'pull-request',
            operationKey: key,
          });
          return recovered.status === 'found'
            ? this.services.github.getPullRequest(recovered.number)
            : undefined;
        },
      );
      number = created.number;
    } else {
      const key = `pull-request-update:${number}:${digest(body)}`;
      const pullNumber = number;
      await externalEffect(
        this.ledger,
        {
          key,
          kind: 'pull-request',
          issue: issue.number,
          state: 'intended',
          input: { number: pullNumber, body },
        },
        () => this.services.github.updatePullRequest(pullNumber, { body }),
        async () => {
          const candidate = await this.services.github.getPullRequest(pullNumber);
          return candidate.body.includes(body) ? candidate : undefined;
        },
      );
    }
    this.save({ ...issue, pullRequest: number, stage: 'ci' });
  }

  private async candidate(issue: DeliveryIssue): Promise<DeliveryStepResult> {
    if (issue.pullRequest === undefined || issue.candidateSha === undefined) {
      throw new DeliveryError('pull-request-candidate-missing');
    }
    const prerequisites = await this.services.github.inspectPrerequisites(
      this.mandate.requiredChecks,
      this.mandate.workflowTreeSha,
    );
    if (!prerequisites.allowed) {
      this.ledger.set('github-enforcement-blockers', prerequisites.blockers);
      throw new DeliveryError('github-enforcement-drift', true);
    }
    const pull = await this.services.github.getPullRequest(issue.pullRequest);
    if (pull.merged && pull.mergeCommitSha !== null) {
      this.save({ ...issue, mergedSha: pull.mergeCommitSha, stage: 'main-ci' });
      return { waitMs: CI_WAIT_MS };
    }
    const main = await this.services.github.getMain();
    if (main !== issue.baseSha) {
      await this.services.repository.git(
        requireWorktree(issue),
        ['fetch', 'origin', 'main'],
        issue.number,
      );
      try {
        await this.services.repository.git(
          requireWorktree(issue),
          ['merge', '--no-edit', 'origin/main'],
          issue.number,
          true,
        );
        this.save({ ...issue, baseSha: main, stage: 'verify' });
      } catch (error) {
        if (
          this.execution.signal?.aborted === true ||
          (error instanceof DeliveryError && error.isShared)
        ) {
          throw error;
        }
        this.beginRepair(issue.number, `merge-conflict:${issue.candidateSha}:${main}`);
        this.save({
          ...issue,
          baseSha: main,
          stage: 'implement',
          feedback:
            'The ordinary merge of current main failed. Inspect and resolve unmerged paths against current contracts, then request renewed verification and independent review.',
        });
      }
      return { waitMs: 0 };
    }
    const headChecks = await this.services.github.getChecks(issue.candidateSha);
    const hasAllHeadChecks = this.mandate.requiredChecks.every((required) =>
      headChecks.some(
        (check) => check.context === required.context && check.appId === required.appId,
      ),
    );
    const expectedCheckSha =
      !hasAllHeadChecks && pull.mergeCommitSha !== null ? pull.mergeCommitSha : issue.candidateSha;
    const assessment = await this.services.github.assessCandidate({
      number: issue.pullRequest,
      expectedHeadSha: issue.candidateSha,
      expectedBaseSha: issue.baseSha,
      expectedCheckSha,
      checks: this.mandate.requiredChecks,
      workflowTreeSha: this.mandate.workflowTreeSha,
      actor: this.mandate.actor,
    });
    if (!assessment.allowed) {
      if (assessment.prerequisitesAllowed === false) {
        throw new DeliveryError('github-enforcement-drift', true);
      }
      if (assessment.blockers.includes('The delivery GitHub actor changed.')) {
        throw new DeliveryError('github-actor-changed', true);
      }
      if (
        assessment.blockers.includes('The candidate changed trusted workflow producer definitions.')
      ) {
        throw new DeliveryError('candidate-workflow-producers-changed');
      }
      if (assessment.pullRequest.headSha !== issue.candidateSha) {
        throw new DeliveryError('candidate-head-changed');
      }
      if (
        assessment.pullRequest.state !== 'open' ||
        assessment.pullRequest.draft ||
        assessment.pullRequest.baseRef !== 'main'
      ) {
        throw new DeliveryError('candidate-pull-request-state-changed');
      }
      const failed = assessment.checks.filter(
        (check) =>
          prerequisites.requiredChecks.some(
            (required) => required.context === check.context && required.appId === check.appId,
          ) &&
          check.status === 'completed' &&
          check.conclusion !== 'success',
      );
      if (failed.length > 0) {
        this.beginRepair(issue.number, `github-check:${issue.candidateSha}:${digest(failed)}`);
        this.save({
          ...issue,
          stage: 'implement',
          feedback: JSON.stringify({
            reason:
              'Required GitHub verification failed. Correct evidenced defects and obtain renewed local checks and independent review.',
            checks: failed.map((check) => ({
              context: check.context,
              sha: check.sha,
              conclusion: check.conclusion,
              url: check.url,
            })),
          }),
        });
        return { waitMs: 0 };
      }
      this.ledger.event('candidate-wait', { issue: issue.number, blockers: assessment.blockers });
      return { waitMs: CI_WAIT_MS };
    }
    await this.assertCandidateExclusions(issue);
    const candidate = await this.services.repository.treeDigest(
      requireWorktree(issue),
      issue.number,
    );
    this.admitLocal(issue, candidate);
    const live = this.ledger.get<LiveReceipt>(`live:${issue.number}`);
    const paths = await this.services.repository.changedPaths(
      requireWorktree(issue),
      issue.baseSha,
      issue.number,
    );
    if (needsLiveGate(paths, this.ledger.get<string>(`live-uncertainty:${issue.number}`) ?? '')) {
      if (live === undefined) {
        throw new DeliveryError('required-live-evidence-missing');
      }
      await this.services.validateLive(issue, live);
      admitLiveReceipt(
        live,
        candidate,
        await this.liveInputs(issue),
        this.admitLocal(issue, candidate),
      );
    }
    if (issue.stage === 'ci') {
      this.save({ ...issue, stage: 'merge' });
      return { waitMs: 0 };
    }
    const key = `merge:${issue.pullRequest}:${issue.candidateSha}`;
    const number = issue.pullRequest;
    const head = issue.candidateSha;
    const merged = await externalEffect(
      this.ledger,
      {
        key,
        kind: 'merge',
        issue: issue.number,
        state: 'intended',
        input: { number, head, base: main },
      },
      () => this.services.github.mergePullRequest({ number, expectedHeadSha: head }),
      async () => {
        const current = await this.services.github.getPullRequest(number);
        return current.merged && current.mergeCommitSha !== null
          ? { sha: current.mergeCommitSha, merged: true as const }
          : undefined;
      },
    );
    this.save({ ...issue, mergedSha: merged.sha, stage: 'main-ci' });
    this.ledger.event(
      'merged-verification-pending',
      { issue: issue.number, pullRequest: number, sha: merged.sha },
      true,
    );
    return { waitMs: CI_WAIT_MS };
  }

  private async mainCi(issue: DeliveryIssue): Promise<DeliveryStepResult> {
    if (issue.mergedSha === undefined) {
      throw new DeliveryError('merged-revision-missing', true);
    }
    const prerequisites = await this.services.github.inspectPrerequisites(
      this.mandate.requiredChecks,
      this.mandate.workflowTreeSha,
    );
    if (!prerequisites.allowed) {
      throw new DeliveryError('github-enforcement-drift', true);
    }
    const checks = await this.services.github.getChecks(issue.mergedSha);
    const failures = assessRequiredChecks(issue.mergedSha, prerequisites.requiredChecks, checks);
    if (failures.length > 0) {
      if (
        checks.some(
          (check) =>
            prerequisites.requiredChecks.some(
              (required) => check.context === required.context && check.appId === required.appId,
            ) &&
            check.status === 'completed' &&
            check.conclusion !== 'success',
        )
      ) {
        throw new DeliveryError('integrated-main-check-failed', true);
      }
      return { waitMs: CI_WAIT_MS };
    }
    await this.services.repository.git(
      requireWorktree(issue),
      ['fetch', 'origin', 'main'],
      issue.number,
    );
    await this.services.repository.git(
      requireWorktree(issue),
      ['merge-base', '--is-ancestor', issue.mergedSha, 'origin/main'],
      issue.number,
    );
    const mergedTree = await this.services.repository.git(
      requireWorktree(issue),
      ['rev-parse', `${issue.mergedSha}^{tree}`],
      issue.number,
    );
    const candidateTree = await this.services.repository.git(
      requireWorktree(issue),
      ['rev-parse', `${issue.candidateSha ?? 'missing'}^{tree}`],
      issue.number,
    );
    if (mergedTree !== candidateTree) {
      throw new DeliveryError('merged-tree-differs-from-reviewed-candidate', true);
    }
    this.save({ ...issue, stage: 'reconcile' });
    return { waitMs: 0 };
  }

  private async reconcile(issue: DeliveryIssue): Promise<void> {
    const key = `close-merged:${issue.number}:${issue.mergedSha ?? ''}`;
    await externalEffect(
      this.ledger,
      {
        key,
        kind: 'issue',
        issue: issue.number,
        state: 'intended',
        input: { sha: issue.mergedSha },
      },
      () => this.services.github.closeIssue(issue.number, 'completed'),
      async () => {
        const current = await this.services.github.getIssue(issue.number);
        return current.state === 'closed' ? current : undefined;
      },
    );
    await this.project(issue, 'done');
    await this.services.repository.finalizeWorktree(requireWorktree(issue), issue.number);
    this.save({ ...issue, stage: 'done' });
    this.ledger.event(
      'delivered',
      { issue: issue.number, pullRequest: issue.pullRequest, mergedSha: issue.mergedSha },
      true,
    );
  }

  async step(): Promise<DeliveryStepResult> {
    this.ledger.assertAuthorized('verify');
    const issue = activeIssue(this.ledger);
    if (issue === undefined) {
      return this.choose();
    }
    this.ledger.assertAuthorized('verify', issue.number);
    if (this.ledger.budget(issue.number, this.services.now()).availableMs <= 0) {
      await this.defer(issue, 'issue-active-limit', 'Explicit operator allowance is required.');
      return { waitMs: 0 };
    }
    try {
      if (
        issue.stage !== 'recover' &&
        issue.stage !== 'main-ci' &&
        issue.stage !== 'reconcile' &&
        this.observeProblem(issue, await this.services.github.getIssue(issue.number)) !== issue
      ) {
        return { waitMs: 0 };
      }
      switch (issue.stage) {
        case 'recover':
          await this.recover(issue);
          break;
        case 'refine':
          await this.refine(issue);
          break;
        case 'plan':
          await this.plan(issue);
          break;
        case 'implement':
          await this.implement(issue);
          break;
        case 'verify':
          await this.verify(issue);
          break;
        case 'review':
          await this.review(issue);
          break;
        case 'commit':
          await this.commit(issue);
          break;
        case 'live':
          await this.live(issue);
          break;
        case 'pull-request':
          await this.pullRequest(issue);
          break;
        case 'ci':
        case 'merge':
          return await this.candidate(issue);
        case 'main-ci':
          return await this.mainCi(issue);
        case 'reconcile':
          await this.reconcile(issue);
          break;
        case 'done':
        case 'deferred':
          break;
      }
    } catch (error) {
      if (error instanceof GitHubOperationError && error.retryAtMs !== undefined) {
        throw error;
      }
      if (
        this.ledger.mode() !== 'active' ||
        this.execution.signal?.aborted === true ||
        (error instanceof DeliveryError && error.isShared)
      ) {
        throw error;
      }
      const admission = this.ledger.get<{ issue: number; code: string }>(
        'execution-admission-blocker',
      );
      const code =
        admission?.issue === issue.number
          ? admission.code
          : error instanceof DeliveryError
            ? error.code
            : 'delivery-stage-failed';
      await this.defer(
        this.ledger.issue(issue.number) ?? issue,
        code,
        'Reconsider when the recorded blocker condition changes; uncertain external effects require reconciliation.',
      );
    }
    return { waitMs: 0 };
  }
}

export async function productionDeliveryServices(
  ledger: DeliveryLedger,
  execution: ExecutionControl,
  authentication: {
    readonly readToken?: typeof readExistingGitHubToken;
    readonly actor?: (transport: GitHubTransport) => Promise<string>;
  } = {},
): Promise<DeliveryServices> {
  const mandate = ledger.mandate();
  const requestIssue = ledger.get<number>('current-issue') ?? 0;
  ledger.assertAuthorized('verify', requestIssue);
  assertExecutionAllowed(execution);
  const token = await (authentication.readToken ?? readExistingGitHubToken)({
    cwd: mandate.sourceRoot,
    timeoutMs: Math.max(
      1,
      Math.floor(
        Math.min(
          30_000,
          mandate.profile.bounds.commandTimeoutMs,
          (execution.deadlineEpochMs ?? Infinity) - Date.now(),
        ),
      ),
    ),
    ...(execution.signal === undefined ? {} : { signal: execution.signal }),
  }).catch(() => {
    assertExecutionAllowed(execution);
    throw new DeliveryError('github-existing-credential-unavailable', true);
  });
  const transport = createGhTransport({
    cwd: mandate.sourceRoot,
    timeoutMs: Math.min(30_000, mandate.profile.bounds.commandTimeoutMs),
    env: githubCredentialEnvironment(token),
    beforeRequest: () => {
      assertExecutionAllowed(execution);
      ledger.assertAuthorized('verify', requestIssue);
    },
    readBackoffUntil: () => ledger.get<number>('github-backoff-until'),
    writeBackoffUntil: (retryAtMs) => {
      ledger.set('github-backoff-until', retryAtMs);
    },
  });
  const actor = await (
    authentication.actor ??
    (async (current) => {
      const value = await current.request({ method: 'GET', path: 'user' });
      return typeof value === 'object' &&
        value !== null &&
        'login' in value &&
        typeof value.login === 'string'
        ? value.login
        : '';
    })
  )(transport);
  if (actor !== mandate.actor) {
    throw new DeliveryError('github-actor-changed', true);
  }
  const github = new DeliveryGitHub({ repository: mandate.repository, transport });
  const repository = new RepositoryBroker(ledger, mandate, execution, { token });
  return {
    github,
    repository,
    worker: new CodexDeliveryWorker(mandate),
    now: Date.now,
    validateLive: async (issue, receipt) => {
      const summary = ledger.get<string>(`live-execution-summary:${issue.number}`);
      if (summary === undefined) {
        throw new DeliveryError('retained-live-summary-missing');
      }
      const executionReceipt = await validateLiveExecutionSummary(
        summary,
        receipt.outputDir,
        receipt.testedRevision,
        {
          decoderContext: planningDecoderContext(mandate, ledger.directory, receipt.testedRevision),
          execution,
        },
      );
      if (digest(executionReceipt) !== digest(ledger.get(`live-execution:${issue.number}`))) {
        throw new DeliveryError('retained-live-execution-changed');
      }
    },
    plan: (issue, workDir) =>
      runDeliveryPlan(mandate, issue, workDir, {
        ...execution,
        codexDeniedMcpServers: mandate.mcpServerNames,
      }),
    live: async (issue, outputDir, control) => {
      const executionControlFile = process.env.AGENT_QUORUM_EXECUTION_CONTROL_FILE;
      if (executionControlFile === undefined) {
        throw new DeliveryError('live-execution-control-missing', true);
      }
      const implementation = ledger.get<string>(`live-implementation:${issue.number}`);
      if (implementation === undefined) {
        throw new DeliveryError('live-implementation-revision-missing');
      }
      const decoderContext = planningDecoderContext(mandate, ledger.directory, implementation);
      const remainingActiveMs = Math.floor(ledger.budget(issue.number, Date.now()).availableMs);
      if (remainingActiveMs <= 0) {
        throw new DeliveryError('live-budget-insufficient');
      }
      const requestFile = issueArtifact(ledger, issue.number, `live-request-${randomUUID()}.json`);
      writeFileSync(
        requestFile,
        JSON.stringify({
          stateDirectory: ledger.directory,
          issue: issue.number,
          repositoryRoot: requireWorktree(issue),
          outputDir,
          scenarioTimeoutMs: mandate.profile.bounds.liveScenarioTimeoutMs,
          attemptLimit:
            mandate.profile.bounds.liveStartsPerScenario +
            ledger.counter(`attempt-grant:live:${issue.number}`),
          executionControlFile,
          decoderContext,
          remainingActiveMs,
        }),
        { mode: 0o600 },
      );
      const result = await runDeliveryCommand({
        command: 'pnpm',
        args: ['exec', 'tsx', 'scripts/delivery-smoke.ts', '--request', requestFile],
        cwd: mandate.runtimeRoot,
        execution: control,
      });
      if (result.exitCode !== 0) {
        let reason = 'required-live-gate-failed';
        try {
          const summary: unknown = JSON.parse(result.stdout.trim());
          if (
            typeof summary === 'object' &&
            summary !== null &&
            'reason' in summary &&
            typeof summary.reason === 'string' &&
            [
              'live-budget-insufficient',
              'live-attempt-limit',
              'live-cancelled',
              'live-source-unpinned-or-changed',
              'live-work-owned',
              'invalid-live-request',
              'live-evidence-incompatible',
              'live-verification-blocked',
            ].includes(summary.reason)
          ) {
            reason = summary.reason;
          }
        } catch {
          reason = 'required-live-gate-failed';
        }
        ledger.event('live-gate-blocked', { issue: issue.number, reason, outputDir });
        throw new DeliveryError(reason);
      }
      const receipt = await validateLiveExecutionSummary(result.stdout, outputDir, implementation, {
        decoderContext,
        execution: control,
      });
      ledger.set(`live-execution:${issue.number}`, receipt);
      ledger.set(`live-execution-summary:${issue.number}`, result.stdout);
    },
  };
}

export async function runDeliveryStep(
  ledger: DeliveryLedger,
  execution: ExecutionControl,
  services?: DeliveryServices,
): Promise<DeliveryStepResult> {
  const githubBackoffMs =
    (ledger.get<number>('github-backoff-until') ?? 0) - (services?.now() ?? Date.now());
  if (githubBackoffMs > 0) {
    ledger.set('next-wait-ms', githubBackoffMs);
    return { waitMs: githubBackoffMs };
  }
  try {
    const currentServices = services ?? (await productionDeliveryServices(ledger, execution));
    return await new DeliveryController(ledger, execution, currentServices).step();
  } catch (error) {
    if (ledger.mode() !== 'active' || execution.signal?.aborted === true) {
      return { waitMs: IDLE_WAIT_MS };
    }
    if (error instanceof GitHubOperationError && error.retryAtMs !== undefined) {
      const retryAtMs = Math.max(error.retryAtMs, ledger.get<number>('github-backoff-until') ?? 0);
      ledger.set('github-backoff-until', retryAtMs);
      const waitMs = Math.max(1, retryAtMs - (services?.now() ?? Date.now()));
      ledger.set('next-wait-ms', waitMs);
      return { waitMs };
    }
    const reason = error instanceof DeliveryError ? error.code : 'shared-delivery-failure';
    ledger.set('shared-blocker', {
      reason,
      currentIssue: ledger.get<number>('current-issue') ?? 0,
    });
    ledger.changeMode('blocked', reason);
    return { waitMs: IDLE_WAIT_MS };
  }
}
