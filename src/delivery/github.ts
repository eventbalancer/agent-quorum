import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parse as parseYaml } from 'yaml';

export interface GitHubRequest {
  readonly method: 'GET' | 'POST' | 'PATCH' | 'PUT';
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  readonly signal?: AbortSignal;
}

export interface GitHubTransport {
  request(request: GitHubRequest): Promise<unknown>;
}

export class GitHubOperationError extends Error {
  constructor(
    message: string,
    readonly outcome: 'rejected' | 'unknown',
    readonly retryAtMs?: number,
  ) {
    super(message);
    this.name = 'GitHubOperationError';
  }
}

interface GhTransportOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly now?: () => number;
  readonly readBackoffUntil?: () => number | undefined;
  readonly writeBackoffUntil?: (retryAtMs: number) => void;
  readonly beforeRequest?: (request: GitHubRequest) => void;
  readonly env?: NodeJS.ProcessEnv;
}

interface DeliveryGitHubOptions {
  readonly repository: string;
  readonly transport: GitHubTransport;
  readonly maxPages?: number;
  readonly signal?: AbortSignal;
}

interface CandidateAssessmentInput {
  readonly number: number;
  readonly expectedHeadSha: string;
  readonly expectedBaseSha: string;
  readonly expectedCheckSha?: string;
  readonly checks: readonly RequiredCheck[];
  readonly workflowTreeSha?: string;
  readonly actor?: string;
}

interface CreateIssueInput {
  readonly title: string;
  readonly body: string;
  readonly labels?: readonly string[];
  readonly operationKey: string;
}

interface CreatePullRequestInput {
  readonly title: string;
  readonly body: string;
  readonly head: string;
  readonly draft?: boolean;
  readonly operationKey: string;
}

interface ReconcileCreationInput {
  readonly kind: 'issue' | 'pull-request';
  readonly operationKey: string;
}

interface MergePullRequestInput {
  readonly number: number;
  readonly expectedHeadSha: string;
}

export function createGhTransport(options: GhTransportOptions): GitHubTransport {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxOutputBytes = options.maxOutputBytes ?? 8 * 1024 * 1024;
  const now = options.now ?? Date.now;
  let heldUntil = 0;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1
  ) {
    throw new GitHubOperationError('GitHub transport requires finite positive bounds.', 'rejected');
  }
  return {
    request(request) {
      const currentTime = now();
      const storedBackoff = options.readBackoffUntil?.() ?? 0;
      heldUntil = Math.max(heldUntil, Number.isSafeInteger(storedBackoff) ? storedBackoff : 0);
      if (heldUntil > currentTime) {
        return Promise.reject(
          new GitHubOperationError('GitHub API backoff is active.', 'rejected', heldUntil),
        );
      }
      const args = ['api', '--include', '--method', request.method, request.path];
      args.push('-H', 'Accept: application/vnd.github+json');
      args.push('-H', 'X-GitHub-Api-Version: 2022-11-28');
      if (request.body !== undefined) {
        args.push('--input', '-');
      }
      return new Promise((resolve, reject) => {
        options.beforeRequest?.(request);
        const child = execFile(
          'gh',
          args,
          {
            cwd: options.cwd,
            timeout: timeoutMs,
            maxBuffer: maxOutputBytes,
            killSignal: 'SIGKILL',
            ...(options.env === undefined ? {} : { env: options.env }),
            ...(request.signal === undefined ? {} : { signal: request.signal }),
          },
          (error, stdout) => {
            const status = /^HTTP\/[\d.]+ (\d{3})/u.exec(stdout);
            const statusCode = status?.[1] === undefined ? 0 : Number(status[1]);
            const separator = /\r?\n\r?\n/u.exec(stdout);
            const retryAtMs = githubRateLimitBackoff(
              separator === null ? stdout : stdout.slice(0, separator.index),
              statusCode,
              now(),
            );
            if (retryAtMs !== undefined) {
              heldUntil = Math.max(heldUntil, retryAtMs);
              options.writeBackoffUntil?.(heldUntil);
            }
            if (error !== null || statusCode < 200 || statusCode >= 300) {
              reject(
                new GitHubOperationError(
                  `GitHub request failed (${statusCode || 'transport'}).`,
                  statusCode >= 400 && statusCode < 500 && statusCode !== 408
                    ? 'rejected'
                    : 'unknown',
                  retryAtMs,
                ),
              );
              return;
            }
            try {
              const body =
                separator === null ? '' : stdout.slice(separator.index + separator[0].length);
              resolve(body.trim() === '' ? null : (JSON.parse(body) as unknown));
            } catch {
              reject(new GitHubOperationError('GitHub returned invalid JSON.', 'unknown'));
            }
          },
        );
        child.stdin?.on('error', () => undefined);
        child.stdin?.end(request.body === undefined ? undefined : JSON.stringify(request.body));
      });
    },
  };
}

export async function readExistingGitHubToken(options: {
  readonly cwd: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}): Promise<string> {
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new GitHubOperationError('GitHub credential lookup requires a finite bound.', 'rejected');
  }
  return new Promise((resolve, reject) => {
    execFile(
      'gh',
      ['auth', 'token', '--hostname', 'github.com'],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 4096,
        killSignal: 'SIGKILL',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      },
      (error, stdout) => {
        const token = stdout.trim();
        if (error !== null || token.length === 0 || token.length > 4096 || /\s/u.test(token)) {
          reject(
            new GitHubOperationError(
              'Existing GitHub delivery credential is unavailable.',
              'rejected',
            ),
          );
        } else {
          resolve(token);
        }
      },
    );
  });
}

export function githubCredentialEnvironment(
  token: string,
  ambient: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...ambient,
    GH_TOKEN: token,
    GITHUB_TOKEN: undefined,
    GH_ENTERPRISE_TOKEN: undefined,
    GITHUB_ENTERPRISE_TOKEN: undefined,
    GH_HOST: 'github.com',
    GH_PROMPT_DISABLED: '1',
  };
}

export function githubRateLimitBackoff(
  headers: string,
  status: number,
  nowMs: number,
): number | undefined {
  const values = new Map(
    headers.split(/\r?\n/u).flatMap((line) => {
      const index = line.indexOf(':');
      return index < 1
        ? []
        : [[line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim()] as const];
    }),
  );
  const retryAfter = values.get('retry-after');
  const remaining = values.get('x-ratelimit-remaining');
  if (status !== 429 && remaining !== '0' && !(status >= 400 && retryAfter !== undefined)) {
    return undefined;
  }
  const maximum = nowMs + 7 * 24 * 60 * 60_000;
  const times = [nowMs + 60_000];
  if (retryAfter !== undefined) {
    const parsed = /^\d+(?:\.\d+)?$/u.test(retryAfter)
      ? nowMs + Number(retryAfter) * 1000
      : Date.parse(retryAfter);
    if (Number.isFinite(parsed) && parsed > nowMs) {
      times.push(Math.ceil(parsed));
    }
  }
  const reset = values.get('x-ratelimit-reset');
  if (reset !== undefined && /^\d+$/u.test(reset)) {
    const parsed = Number(reset) * 1000;
    if (Number.isSafeInteger(parsed) && parsed > nowMs) {
      times.push(parsed);
    }
  }
  return Math.min(maximum, Math.max(...times));
}

export interface RequiredCheck {
  readonly context: string;
  readonly appId: number;
}

export interface GitHubIssue {
  readonly number: number;
  readonly nodeId: string;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly assignees: readonly string[];
}

export interface GitHubPullRequest {
  readonly number: number;
  readonly nodeId: string;
  readonly title: string;
  readonly body: string;
  readonly state: string;
  readonly draft: boolean;
  readonly url: string;
  readonly headSha: string;
  readonly headRef: string;
  readonly baseSha: string;
  readonly baseRef: string;
  readonly merged: boolean;
  readonly mergeCommitSha: string | null;
}

export interface GitHubCheck {
  readonly id: number;
  readonly context: string;
  readonly appId: number;
  readonly sha: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly url: string;
}

export interface GitHubPrerequisites {
  readonly allowed: boolean;
  readonly blockers: readonly string[];
  readonly requiredChecks: readonly RequiredCheck[];
  readonly mainSha: string;
}

export interface CandidateAssessment {
  readonly allowed: boolean;
  readonly prerequisitesAllowed?: boolean;
  readonly blockers: readonly string[];
  readonly pullRequest: GitHubPullRequest;
  readonly checks: readonly GitHubCheck[];
  readonly mainSha: string;
}

export interface GitHubProjectMapping {
  readonly projectId: string;
  readonly statusFieldId: string;
  readonly statusOptions: Readonly<Record<string, string>>;
}

export interface GitHubProjectItem {
  readonly id: string;
  readonly contentId: string | null;
  readonly statusOptionId: string | null;
}

interface MergePullRequestResult {
  readonly sha: string;
  readonly merged: true;
}

type GitHubTextUpdate = Partial<Readonly<Record<'title' | 'body', string>>>;

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new GitHubOperationError('GitHub returned an invalid object.', 'unknown');
  }
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new GitHubOperationError('GitHub returned an invalid collection.', 'unknown');
  }
  return value as unknown[];
}

function string(value: unknown): string {
  if (typeof value !== 'string') {
    throw new GitHubOperationError('GitHub returned an invalid string.', 'unknown');
  }
  return value;
}

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new GitHubOperationError('GitHub returned an invalid identifier.', 'unknown');
  }
  return value;
}

function issueFromResponse(value: unknown): GitHubIssue {
  const result = object(value);
  return {
    number: integer(result.number),
    nodeId: string(result.node_id),
    title: string(result.title),
    body: result.body === null ? '' : string(result.body),
    state: string(result.state),
    updatedAt: string(result.updated_at),
    url: string(result.html_url),
    labels: array(result.labels).map((label) =>
      typeof label === 'string' ? label : string(object(label).name),
    ),
    assignees: array(result.assignees).map((assignee) => string(object(assignee).login)),
  };
}

function pullRequestFromResponse(value: unknown): GitHubPullRequest {
  const result = object(value);
  const head = object(result.head);
  const base = object(result.base);
  return {
    number: integer(result.number),
    nodeId: string(result.node_id),
    title: string(result.title),
    body: result.body === null ? '' : string(result.body),
    state: string(result.state),
    draft: result.draft === true,
    url: string(result.html_url),
    headSha: string(head.sha),
    headRef: string(head.ref),
    baseSha: string(base.sha),
    baseRef: string(base.ref),
    merged: result.merged === true || typeof result.merged_at === 'string',
    mergeCommitSha: result.merge_commit_sha === null ? null : string(result.merge_commit_sha),
  };
}

export function deliveryOperationMarker(operationKey: string): string {
  if (operationKey.trim() === '') {
    throw new GitHubOperationError('An operation key is required.', 'rejected');
  }
  const fingerprint = createHash('sha256').update(operationKey).digest('hex');
  return `<!-- agent-quorum-delivery:${fingerprint} -->`;
}

function markedBody(body: string, operationKey: string): string {
  const marker = deliveryOperationMarker(operationKey);
  return body.includes(marker) ? body : `${body}\n\n${marker}`;
}

function preserveOperationMarkers(body: string, previous: string): string {
  const markers = previous.match(/<!-- agent-quorum-delivery:[a-f0-9]{64} -->/gu) ?? [];
  return [body, ...markers.filter((marker) => !body.includes(marker))].join('\n\n');
}

function uniqueChecks(checks: readonly RequiredCheck[]): RequiredCheck[] {
  const contexts = new Map<string, RequiredCheck>();
  for (const check of checks) {
    const previous = contexts.get(check.context);
    if (previous !== undefined && previous.appId !== check.appId) {
      throw new GitHubOperationError(`Conflicting check provenance: ${check.context}.`, 'rejected');
    }
    contexts.set(check.context, check);
  }
  return [...contexts.values()].sort((left, right) => left.context.localeCompare(right.context));
}

export function assessRequiredChecks(
  sha: string,
  required: readonly RequiredCheck[],
  checks: readonly GitHubCheck[],
): string[] {
  return uniqueChecks(required).flatMap((requirement) => {
    const matches = checks.filter(
      (check) => check.context === requirement.context && check.appId === requirement.appId,
    );
    const latest = matches.sort((left, right) => right.id - left.id)[0];
    if (latest?.sha !== sha || latest.status !== 'completed' || latest.conclusion !== 'success') {
      return [`Required check is not successful for ${sha}: ${requirement.context}.`];
    }
    return [];
  });
}

export class DeliveryGitHub {
  private readonly repository: string;
  private readonly transport: GitHubTransport;
  private readonly maxPages: number;
  private readonly signal: AbortSignal | undefined;

  constructor(options: DeliveryGitHubOptions) {
    if (options.repository !== 'eventbalancer/agent-quorum') {
      throw new GitHubOperationError(
        'Delivery is restricted to eventbalancer/agent-quorum.',
        'rejected',
      );
    }
    this.repository = options.repository;
    this.transport = options.transport;
    this.maxPages = options.maxPages ?? 100;
    this.signal = options.signal;
    if (!Number.isSafeInteger(this.maxPages) || this.maxPages < 1 || this.maxPages > 1000) {
      throw new GitHubOperationError('GitHub pagination requires a finite page bound.', 'rejected');
    }
  }

  private async request(
    method: GitHubRequest['method'],
    path: string,
    body?: Readonly<Record<string, unknown>>,
  ): Promise<unknown> {
    return this.transport.request({
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
  }

  private repositoryPath(suffix = ''): string {
    return `repos/${this.repository}${suffix}`;
  }

  private async pages(path: string, collection?: string): Promise<unknown[]> {
    const result: unknown[] = [];
    for (let page = 1; page <= this.maxPages; page += 1) {
      const separator = path.includes('?') ? '&' : '?';
      const response = await this.request('GET', `${path}${separator}per_page=100&page=${page}`);
      const entries = array(collection === undefined ? response : object(response)[collection]);
      result.push(...entries);
      if (entries.length < 100) {
        return result;
      }
    }
    throw new GitHubOperationError(
      'GitHub pagination limit reached; reconciliation is incomplete.',
      'unknown',
    );
  }

  async getMain(): Promise<string> {
    const response = object(await this.request('GET', this.repositoryPath('/git/ref/heads/main')));
    return string(object(response.object).sha);
  }

  async listIssues(state: 'open' | 'closed' | 'all' = 'open'): Promise<GitHubIssue[]> {
    const entries = await this.pages(
      this.repositoryPath(`/issues?state=${state}&sort=created&direction=asc`),
    );
    return entries
      .filter((entry) => object(entry).pull_request === undefined)
      .map(issueFromResponse);
  }

  async getIssue(number: number): Promise<GitHubIssue> {
    return issueFromResponse(
      await this.request('GET', this.repositoryPath(`/issues/${integer(number)}`)),
    );
  }

  async listPullRequests(state: 'open' | 'closed' | 'all' = 'open'): Promise<GitHubPullRequest[]> {
    const entries = await this.pages(
      this.repositoryPath(`/pulls?state=${state}&sort=created&direction=asc`),
    );
    return entries.map(pullRequestFromResponse);
  }

  async getPullRequest(number: number): Promise<GitHubPullRequest> {
    return pullRequestFromResponse(
      await this.request('GET', this.repositoryPath(`/pulls/${integer(number)}`)),
    );
  }

  async getDependencies(number: number): Promise<GitHubIssue[]> {
    return (
      await this.pages(this.repositoryPath(`/issues/${integer(number)}/dependencies/blocked_by`))
    ).map(issueFromResponse);
  }

  async getChecks(sha: string): Promise<GitHubCheck[]> {
    const entries = await this.pages(
      this.repositoryPath(`/commits/${encodeURIComponent(sha)}/check-runs?filter=latest`),
      'check_runs',
    );
    return entries.map((entry) => {
      const check = object(entry);
      return {
        id: integer(check.id),
        context: string(check.name),
        appId: integer(object(check.app).id),
        sha: string(check.head_sha),
        status: string(check.status),
        conclusion: check.conclusion === null ? null : string(check.conclusion),
        url: string(check.html_url),
      };
    });
  }

  async getWorkflowTreeSha(revision: string): Promise<string> {
    const root = object(
      await this.request('GET', this.repositoryPath(`/git/trees/${encodeURIComponent(revision)}`)),
    );
    if (root.truncated !== false) {
      throw new GitHubOperationError('Git tree evidence is incomplete.', 'rejected');
    }
    const github = array(root.tree)
      .map(object)
      .find((entry) => entry.path === '.github' && entry.type === 'tree');
    if (github === undefined) {
      throw new GitHubOperationError('GitHub workflow tree is unavailable.', 'rejected');
    }
    return string(github.sha);
  }

  async assessWorkflowProvenance(treeSha: string): Promise<readonly string[]> {
    const response = object(
      await this.request(
        'GET',
        this.repositoryPath(`/git/trees/${encodeURIComponent(treeSha)}?recursive=1`),
      ),
    );
    if (response.truncated !== false) {
      throw new GitHubOperationError('Workflow tree evidence is incomplete.', 'rejected');
    }
    const blockers: string[] = [];
    if (
      array(response.tree)
        .map(object)
        .some((entry) => entry.mode === '120000')
    ) {
      blockers.push('Trusted GitHub producer content contains a symbolic link.');
    }
    const definitions = array(response.tree)
      .map(object)
      .filter(
        (entry) =>
          entry.type === 'blob' &&
          /(?:^workflows\/.*\.ya?ml$|(?:^|\/)action\.ya?ml$)/u.test(string(entry.path)),
      );
    if (definitions.length === 0) {
      blockers.push('No workflow producers were found.');
    }
    for (const entry of definitions) {
      const blob = object(
        await this.request(
          'GET',
          this.repositoryPath(`/git/blobs/${encodeURIComponent(string(entry.sha))}`),
        ),
      );
      if (blob.encoding !== 'base64') {
        throw new GitHubOperationError('Workflow content encoding is unavailable.', 'rejected');
      }
      const visit = (value: unknown): void => {
        if (Array.isArray(value)) {
          value.forEach(visit);
          return;
        }
        if (typeof value !== 'object' || value === null) {
          return;
        }
        for (const [key, child] of Object.entries(value)) {
          if (key === 'uses') {
            if (
              typeof child !== 'string' ||
              !(
                /^[\w./-]+@[a-f0-9]{40}$/u.test(child) ||
                /^docker:\/\/.+@sha256:[a-f0-9]{64}$/u.test(child) ||
                (/^\.\/\.github\/(?:actions|workflows)\/[\w./-]+$/u.test(child) &&
                  !child
                    .split('/')
                    .slice(1)
                    .some((part) => part === '.' || part === '..'))
              )
            ) {
              blockers.push(
                `Workflow action reference is not pinned to trusted immutable content: ${string(entry.path)}.`,
              );
            }
          } else {
            visit(child);
          }
        }
      };
      visit(parseYaml(Buffer.from(string(blob.content), 'base64').toString('utf8')) as unknown);
    }
    return blockers;
  }

  async inspectPrerequisites(
    frozenChecks: readonly RequiredCheck[],
    workflowTreeSha?: string,
  ): Promise<GitHubPrerequisites> {
    const blockers: string[] = [];
    const repository = object(await this.request('GET', this.repositoryPath()));
    const mainSha = await this.getMain();
    if (
      workflowTreeSha !== undefined &&
      (await this.getWorkflowTreeSha(mainSha)) !== workflowTreeSha
    ) {
      blockers.push('The trusted workflow producer definitions changed on main.');
    }
    if (object(repository.permissions).push !== true) {
      blockers.push('GitHub write permission is unavailable.');
    }
    if (repository.allow_merge_commit !== true) {
      blockers.push('GitHub merge commits are unavailable.');
    }
    const rules = array(await this.request('GET', this.repositoryPath('/rules/branches/main'))).map(
      object,
    );
    const requiredChecks = [...uniqueChecks(frozenChecks)];
    const enforcedContexts = new Set<string>();
    const rulesetCache = new Map<number, Record<string, unknown>>();
    let enforcedPullRequest = false;
    for (const rule of rules) {
      if (rule.type !== 'required_status_checks' && rule.type !== 'pull_request') {
        continue;
      }
      const rulesetId = integer(rule.ruleset_id);
      let ruleset = rulesetCache.get(rulesetId);
      if (ruleset === undefined) {
        ruleset = object(await this.request('GET', this.repositoryPath(`/rulesets/${rulesetId}`)));
        rulesetCache.set(rulesetId, ruleset);
      }
      const enforced =
        ruleset.enforcement === 'active' && ruleset.current_user_can_bypass === 'never';
      if (rule.type === 'pull_request') {
        enforcedPullRequest ||= enforced;
        continue;
      }
      const parameters = object(rule.parameters);
      for (const entry of array(parameters.required_status_checks)) {
        const requirement = object(entry);
        const context = string(requirement.context);
        const frozen = frozenChecks.find((check) => check.context === context);
        const appId =
          typeof requirement.integration_id === 'number' && requirement.integration_id > 0
            ? requirement.integration_id
            : frozen?.appId;
        if (appId === undefined) {
          blockers.push(`Required check has no trusted application provenance: ${context}.`);
        } else {
          requiredChecks.push({ context, appId });
        }
        if (enforced && parameters.strict_required_status_checks_policy === true) {
          enforcedContexts.add(context);
        }
      }
    }
    if (!enforcedPullRequest) {
      blockers.push('Pull-request delivery is not enforced for the delivery actor.');
    }
    const combined = uniqueChecks(requiredChecks);
    if (combined.length === 0) {
      blockers.push('No required verification checks are configured.');
    }
    for (const check of combined) {
      if (!enforcedContexts.has(check.context)) {
        blockers.push(`Strict, non-bypassable status checking is unavailable: ${check.context}.`);
      }
    }
    return { allowed: blockers.length === 0, blockers, requiredChecks: combined, mainSha };
  }

  async assessCandidate(input: CandidateAssessmentInput): Promise<CandidateAssessment> {
    const prerequisites = await this.inspectPrerequisites(input.checks, input.workflowTreeSha);
    const pullRequest = await this.getPullRequest(input.number);
    const checkSha = input.expectedCheckSha ?? input.expectedHeadSha;
    const checks = await this.getChecks(checkSha);
    const blockers = [...prerequisites.blockers];
    if (
      input.workflowTreeSha !== undefined &&
      (await this.getWorkflowTreeSha(input.expectedHeadSha)) !== input.workflowTreeSha
    ) {
      blockers.push('The candidate changed trusted workflow producer definitions.');
    }
    if (
      input.actor !== undefined &&
      object(await this.request('GET', 'user')).login !== input.actor
    ) {
      blockers.push('The delivery GitHub actor changed.');
    }
    if (
      pullRequest.state !== 'open' ||
      pullRequest.draft ||
      pullRequest.merged ||
      pullRequest.baseRef !== 'main'
    ) {
      blockers.push('The candidate is not an open, ready pull request into main.');
    }
    if (pullRequest.headSha !== input.expectedHeadSha) {
      blockers.push('The pull request head changed after verification.');
    }
    if (
      pullRequest.baseSha !== input.expectedBaseSha ||
      prerequisites.mainSha !== input.expectedBaseSha
    ) {
      blockers.push('The merge base changed after verification.');
    }
    if (checkSha !== pullRequest.headSha && checkSha !== pullRequest.mergeCommitSha) {
      blockers.push('The assessed check revision is not the current head or merge candidate.');
    }
    blockers.push(...assessRequiredChecks(checkSha, prerequisites.requiredChecks, checks));
    return {
      allowed: blockers.length === 0,
      prerequisitesAllowed: prerequisites.allowed,
      blockers,
      pullRequest,
      checks,
      mainSha: prerequisites.mainSha,
    };
  }

  async reconcileCreation(
    input: ReconcileCreationInput,
  ): Promise<
    | { readonly status: 'found'; readonly number: number; readonly url: string }
    | { readonly status: 'absent' | 'ambiguous' }
  > {
    const marker = deliveryOperationMarker(input.operationKey);
    const entries =
      input.kind === 'issue' ? await this.listIssues('all') : await this.listPullRequests('all');
    const matches = entries.filter((entry) => entry.body.includes(marker));
    const match = matches[0];
    if (matches.length > 1) {
      return { status: 'ambiguous' };
    }
    return match === undefined
      ? { status: 'absent' }
      : { status: 'found', number: match.number, url: match.url };
  }

  async createIssue(input: CreateIssueInput): Promise<GitHubIssue> {
    return issueFromResponse(
      await this.request('POST', this.repositoryPath('/issues'), {
        title: input.title,
        body: markedBody(input.body, input.operationKey),
        ...(input.labels === undefined ? {} : { labels: input.labels }),
      }),
    );
  }

  async updateIssue(number: number, input: GitHubTextUpdate): Promise<GitHubIssue> {
    const update =
      input.body === undefined
        ? input
        : {
            ...input,
            body: preserveOperationMarkers(input.body, (await this.getIssue(number)).body),
          };
    return issueFromResponse(
      await this.request('PATCH', this.repositoryPath(`/issues/${integer(number)}`), { ...update }),
    );
  }

  async closeIssue(number: number, reason: 'completed' | 'not_planned'): Promise<GitHubIssue> {
    return issueFromResponse(
      await this.request('PATCH', this.repositoryPath(`/issues/${integer(number)}`), {
        state: 'closed',
        state_reason: reason,
      }),
    );
  }

  async createPullRequest(input: CreatePullRequestInput): Promise<GitHubPullRequest> {
    return pullRequestFromResponse(
      await this.request('POST', this.repositoryPath('/pulls'), {
        title: input.title,
        body: markedBody(input.body, input.operationKey),
        head: input.head,
        base: 'main',
        draft: input.draft ?? false,
      }),
    );
  }

  async updatePullRequest(number: number, input: GitHubTextUpdate): Promise<GitHubPullRequest> {
    const update =
      input.body === undefined
        ? input
        : {
            ...input,
            body: preserveOperationMarkers(input.body, (await this.getPullRequest(number)).body),
          };
    return pullRequestFromResponse(
      await this.request('PATCH', this.repositoryPath(`/pulls/${integer(number)}`), { ...update }),
    );
  }

  async mergePullRequest(input: MergePullRequestInput): Promise<MergePullRequestResult> {
    const response = object(
      await this.request('PUT', this.repositoryPath(`/pulls/${integer(input.number)}/merge`), {
        sha: input.expectedHeadSha,
        merge_method: 'merge',
      }),
    );
    if (response.merged !== true) {
      throw new GitHubOperationError('GitHub did not confirm the pull request merge.', 'unknown');
    }
    return { sha: string(response.sha), merged: true };
  }

  private async graphql(
    query: string,
    variables: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    const result = object(await this.request('POST', 'graphql', { query, variables }));
    if (result.errors !== undefined) {
      throw new GitHubOperationError(
        'GitHub project operation returned GraphQL errors.',
        'unknown',
      );
    }
    return object(result.data);
  }

  async listProjectItems(mapping: GitHubProjectMapping): Promise<GitHubProjectItem[]> {
    const items: GitHubProjectItem[] = [];
    let cursor: string | null = null;
    for (let page = 1; page <= this.maxPages; page += 1) {
      const response = await this.graphql(
        'query($project:ID!,$cursor:String){node(id:$project){...on ProjectV2{items(first:100,after:$cursor){nodes{id content{...on Issue{id} ...on PullRequest{id}} fieldValues(first:100){nodes{...on ProjectV2ItemFieldSingleSelectValue{optionId field{...on ProjectV2SingleSelectField{id}}}} pageInfo{hasNextPage}}} pageInfo{hasNextPage endCursor}}}}}',
        { project: mapping.projectId, cursor },
      );
      const collection = object(object(response.node).items);
      for (const entry of array(collection.nodes)) {
        const item = object(entry);
        const fields = object(item.fieldValues);
        if (object(fields.pageInfo).hasNextPage !== false) {
          throw new GitHubOperationError('Project field pagination is incomplete.', 'unknown');
        }
        const status = array(fields.nodes)
          .map(object)
          .find(
            (field) =>
              field.field !== undefined && object(field.field).id === mapping.statusFieldId,
          );
        items.push({
          id: string(item.id),
          contentId: item.content === null ? null : string(object(item.content).id),
          statusOptionId: status === undefined ? null : string(status.optionId),
        });
      }
      const pageInfo = object(collection.pageInfo);
      if (pageInfo.hasNextPage === false) {
        return items;
      }
      const nextCursor = string(pageInfo.endCursor);
      if (nextCursor === cursor) {
        throw new GitHubOperationError('GitHub project pagination did not advance.', 'unknown');
      }
      cursor = nextCursor;
    }
    throw new GitHubOperationError('GitHub project pagination limit reached.', 'unknown');
  }

  async addProjectItem(mapping: GitHubProjectMapping, contentId: string): Promise<string> {
    const added = await this.graphql(
      'mutation($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}',
      { project: mapping.projectId, content: contentId },
    );
    return string(object(object(added.addProjectV2ItemById).item).id);
  }

  async updateProjectItemStatus(
    mapping: GitHubProjectMapping,
    itemId: string,
    status: string,
  ): Promise<void> {
    const optionId = mapping.statusOptions[status];
    if (optionId === undefined) {
      throw new GitHubOperationError(`Project status is not configured: ${status}.`, 'rejected');
    }
    await this.graphql(
      'mutation($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}',
      { project: mapping.projectId, item: itemId, field: mapping.statusFieldId, option: optionId },
    );
  }

  async setProjectStatus(
    mapping: GitHubProjectMapping,
    contentId: string,
    status: string,
  ): Promise<void> {
    const optionId = mapping.statusOptions[status];
    if (optionId === undefined) {
      throw new GitHubOperationError(`Project status is not configured: ${status}.`, 'rejected');
    }
    const items = (await this.listProjectItems(mapping)).filter(
      (item) => item.contentId === contentId,
    );
    if (items.length > 1) {
      throw new GitHubOperationError('Project item ownership is ambiguous.', 'unknown');
    }
    const existing = items[0];
    if (existing?.statusOptionId === optionId) {
      return;
    }
    const itemId = existing?.id ?? (await this.addProjectItem(mapping, contentId));
    await this.updateProjectItemStatus(mapping, itemId, status);
  }
}
