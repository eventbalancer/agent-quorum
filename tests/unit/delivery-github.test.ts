import { describe, expect, it, vi } from 'vitest';
import {
  assessRequiredChecks,
  createGhTransport,
  DeliveryGitHub,
  deliveryOperationMarker,
  GitHubOperationError,
  githubRateLimitBackoff,
} from '../../src/delivery/github.js';

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFile: execFileMock }));
import type {
  GitHubCheck,
  GitHubRequest,
  GitHubTransport,
  RequiredCheck,
} from '../../src/delivery/github.js';

const repository = 'eventbalancer/agent-quorum';
const prefix = `repos/${repository}`;
const required: RequiredCheck[] = [{ context: 'check (ubuntu-latest, 24)', appId: 15368 }];

class FakeTransport implements GitHubTransport {
  readonly calls: GitHubRequest[] = [];

  constructor(private readonly respond: (request: GitHubRequest) => unknown) {}

  request(request: GitHubRequest): Promise<unknown> {
    this.calls.push(request);
    return Promise.resolve().then(() => this.respond(request));
  }
}

function issue(number: number, body = ''): Record<string, unknown> {
  return {
    number,
    node_id: `I_${number}`,
    title: `Issue ${number}`,
    body,
    state: 'open',
    updated_at: '2026-09-05T00:00:00Z',
    html_url: `https://github.com/${repository}/issues/${number}`,
    labels: [{ name: 'bug' }],
    assignees: [],
  };
}

function pullRequest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...issue(1),
    draft: false,
    head: { sha: 'head-sha', ref: 'session/issue-1' },
    base: { sha: 'base-sha', ref: 'main' },
    merge_commit_sha: 'candidate-sha',
    merged: false,
    ...overrides,
  };
}

function check(overrides: Partial<GitHubCheck> = {}): GitHubCheck {
  return {
    id: 1,
    context: required[0]?.context ?? '',
    appId: 15368,
    sha: 'head-sha',
    status: 'completed',
    conclusion: 'success',
    url: 'https://github.com/checks/1',
    ...overrides,
  };
}

function prerequisiteResponse(
  request: GitHubRequest,
  options: {
    readonly strict?: boolean;
    readonly bypass?: string;
    readonly extraCheck?: boolean;
  } = {},
): unknown {
  if (request.path === prefix) {
    return { permissions: { push: true }, allow_merge_commit: true };
  }
  if (request.path.endsWith('/git/ref/heads/main')) {
    return { object: { sha: 'base-sha' } };
  }
  if (request.path.endsWith('/rules/branches/main')) {
    return [
      { type: 'pull_request', ruleset_id: 1, parameters: {} },
      {
        type: 'required_status_checks',
        ruleset_id: 1,
        parameters: {
          strict_required_status_checks_policy: options.strict ?? true,
          required_status_checks: [
            { context: required[0]?.context, integration_id: 15368 },
            ...(options.extraCheck === true ? [{ context: 'additional', integration_id: 10 }] : []),
          ],
        },
      },
    ];
  }
  if (request.path.endsWith('/rulesets/1')) {
    return { enforcement: 'active', current_user_can_bypass: options.bypass ?? 'never' };
  }
  throw new Error(`Unexpected request: ${request.method} ${request.path}`);
}

describe('GitHub delivery admission', () => {
  it('requires strict checks enforced for this actor and preserves server additions', async () => {
    const transport = new FakeTransport((request) =>
      prerequisiteResponse(request, { extraCheck: true }),
    );
    const client = new DeliveryGitHub({ repository, transport });
    const result = await client.inspectPrerequisites(required);
    expect(result.allowed).toBe(true);
    expect(result.requiredChecks).toEqual([{ context: 'additional', appId: 10 }, ...required]);
    expect(transport.calls.filter((request) => request.path.endsWith('/rulesets/1'))).toHaveLength(
      1,
    );
  });

  it.each([
    { strict: false },
    { bypass: 'always' },
    { bypass: 'pull_requests_only' },
    { bypass: 'unknown' },
  ])('blocks unavailable server enforcement: %j', async (options) => {
    const transport = new FakeTransport((request) => prerequisiteResponse(request, options));
    const result = await new DeliveryGitHub({ repository, transport }).inspectPrerequisites(
      required,
    );
    expect(result.allowed).toBe(false);
    expect(result.blockers.some((blocker) => blocker.includes('non-bypassable'))).toBe(true);
    expect(transport.calls.every((request) => request.method === 'GET')).toBe(true);
  });

  it('rejects missing trusted provenance for newly required server checks', async () => {
    const transport = new FakeTransport((request) => {
      if (request.path.endsWith('/rules/branches/main')) {
        return [
          {
            type: 'required_status_checks',
            ruleset_id: 1,
            parameters: {
              strict_required_status_checks_policy: true,
              required_status_checks: [{ context: 'unknown' }],
            },
          },
        ];
      }
      return prerequisiteResponse(request);
    });
    const result = await new DeliveryGitHub({ repository, transport }).inspectPrerequisites(
      required,
    );
    expect(result.allowed).toBe(false);
    expect(result.blockers).toContain(
      'Required check has no trusted application provenance: unknown.',
    );
  });

  it.each([
    { reason: 'missing check', checks: [] },
    { reason: 'untrusted producer', checks: [check({ appId: 123 })] },
    { reason: 'stale revision', checks: [check({ sha: 'old-sha' })] },
    { reason: 'in-progress check', checks: [check({ status: 'in_progress', conclusion: null })] },
    { reason: 'failed check', checks: [check({ conclusion: 'failure' })] },
    { reason: 'skipped check', checks: [check({ conclusion: 'skipped' })] },
    { reason: 'neutral check', checks: [check({ conclusion: 'neutral' })] },
    {
      reason: 'newer pending check',
      checks: [check(), check({ id: 2, status: 'queued', conclusion: null })],
    },
  ])('rejects required-check evidence with $reason', ({ checks }) => {
    expect(assessRequiredChecks('head-sha', required, checks)).not.toHaveLength(0);
  });

  it('admits successful checks only for the requested code and producer', () => {
    expect(assessRequiredChecks('head-sha', required, [check()])).toEqual([]);
  });

  it('rejects changed head and base before merging', async () => {
    const transport = new FakeTransport((request) => {
      if (request.path.endsWith('/pulls/1')) {
        return pullRequest({ head: { sha: 'changed-head', ref: 'session/issue-1' } });
      }
      if (request.path.includes('/check-runs?')) {
        return {
          check_runs: [
            {
              id: 1,
              name: required[0]?.context,
              app: { id: 15368 },
              head_sha: 'head-sha',
              status: 'completed',
              conclusion: 'success',
              html_url: 'https://github.com/checks/1',
            },
          ],
        };
      }
      return prerequisiteResponse(request);
    });
    const client = new DeliveryGitHub({ repository, transport });
    const result = await client.assessCandidate({
      number: 1,
      expectedHeadSha: 'head-sha',
      expectedBaseSha: 'old-base',
      checks: required,
    });
    expect(result.allowed).toBe(false);
    expect(result.blockers).toContain('The pull request head changed after verification.');
    expect(result.blockers).toContain('The merge base changed after verification.');
    expect(transport.calls.every((request) => request.method === 'GET')).toBe(true);
  });
});

describe('GitHub delivery reconciliation', () => {
  it('paginates issues, filters pull requests, and does not truncate the queue', async () => {
    const transport = new FakeTransport((request) =>
      request.path.endsWith('&page=1')
        ? Array.from({ length: 100 }, (_, index) => issue(index + 1))
        : [{ ...issue(101), pull_request: {} }, issue(102)],
    );
    const client = new DeliveryGitHub({ repository, transport });
    expect(await client.listIssues()).toHaveLength(101);
    expect(transport.calls).toHaveLength(2);
  });

  it('fails closed when complete reconciliation exceeds the finite page bound', async () => {
    const transport = new FakeTransport(() =>
      Array.from({ length: 100 }, (_, index) => issue(index + 1)),
    );
    const client = new DeliveryGitHub({ repository, transport, maxPages: 1 });
    await expect(client.listIssues()).rejects.toThrow('reconciliation is incomplete');
  });

  it('recovers a creation response lost after GitHub accepted the write without repeating it', async () => {
    let stored: Record<string, unknown> | undefined;
    const transport = new FakeTransport((request) => {
      if (request.method === 'POST') {
        stored = issue(42, String(request.body?.body));
        throw new GitHubOperationError('Connection closed.', 'unknown');
      }
      return stored === undefined ? [] : [stored];
    });
    const client = new DeliveryGitHub({ repository, transport });
    await expect(
      client.createIssue({
        title: 'Adjacent finding',
        body: 'Evidence.',
        operationKey: 'finding-1',
      }),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(await client.reconcileCreation({ kind: 'issue', operationKey: 'finding-1' })).toEqual({
      status: 'found',
      number: 42,
      url: `https://github.com/${repository}/issues/42`,
    });
    expect(transport.calls.filter((request) => request.method === 'POST')).toHaveLength(1);
  });

  it('reports ambiguity without deleting or choosing between duplicate markers', async () => {
    const body = deliveryOperationMarker('same-key');
    const transport = new FakeTransport(() => [issue(1, body), issue(2, body)]);
    const client = new DeliveryGitHub({ repository, transport });
    expect(await client.reconcileCreation({ kind: 'issue', operationKey: 'same-key' })).toEqual({
      status: 'ambiguous',
    });
    expect(transport.calls).toHaveLength(1);
  });

  it('passes authored text literally as structured request data', async () => {
    const transport = new FakeTransport((request) => issue(1, String(request.body?.body)));
    const client = new DeliveryGitHub({ repository, transport });
    const title = 'Literal $(command) `code` "quotes"';
    await client.createIssue({ title, body: 'First line\nSecond line', operationKey: 'safe-key' });
    expect(transport.calls[0]?.body).toEqual({
      title,
      body: `First line\nSecond line\n\n${deliveryOperationMarker('safe-key')}`,
    });
  });

  it('preserves recovery markers when issue descriptions are actualized', async () => {
    const marker = deliveryOperationMarker('original-create');
    const transport = new FakeTransport((request) =>
      issue(1, request.method === 'GET' ? marker : String(request.body?.body)),
    );
    const client = new DeliveryGitHub({ repository, transport });
    const result = await client.updateIssue(1, { body: 'Current evidence.' });
    expect(result.body).toBe(`Current evidence.\n\n${marker}`);
  });

  it('merges with exact expected head and merge method without bypass or delayed actions', async () => {
    const transport = new FakeTransport(() => ({ merged: true, sha: 'merged-sha' }));
    const client = new DeliveryGitHub({ repository, transport });
    expect(await client.mergePullRequest({ number: 1, expectedHeadSha: 'head-sha' })).toEqual({
      merged: true,
      sha: 'merged-sha',
    });
    expect(transport.calls).toEqual([
      {
        method: 'PUT',
        path: `${prefix}/pulls/1/merge`,
        body: { sha: 'head-sha', merge_method: 'merge' },
      },
    ]);
  });

  it('does not treat an unconfirmed merge as completion or repeat a rejected merge', async () => {
    const transport = new FakeTransport(() => ({ merged: false, message: 'Base moved.' }));
    const client = new DeliveryGitHub({ repository, transport });
    await expect(
      client.mergePullRequest({ number: 1, expectedHeadSha: 'head-sha' }),
    ).rejects.toMatchObject({ outcome: 'unknown' });
    expect(transport.calls).toHaveLength(1);
  });

  it('requires explicit optional project mapping and does not invent missing statuses', async () => {
    const transport = new FakeTransport(() => {
      throw new Error('No request should be sent.');
    });
    const client = new DeliveryGitHub({ repository, transport });
    await expect(
      client.setProjectStatus(
        { projectId: 'P_1', statusFieldId: 'F_1', statusOptions: {} },
        'I_1',
        'done',
      ),
    ).rejects.toMatchObject({ outcome: 'rejected' });
    expect(transport.calls).toEqual([]);
  });

  it('does not write unchanged configured project status', async () => {
    const transport = new FakeTransport(() => ({
      data: {
        node: {
          items: {
            nodes: [
              {
                id: 'ITEM_1',
                content: { id: 'I_1' },
                fieldValues: {
                  nodes: [{ optionId: 'DONE', field: { id: 'F_1' } }],
                  pageInfo: { hasNextPage: false },
                },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      },
    }));
    const client = new DeliveryGitHub({ repository, transport });
    await client.setProjectStatus(
      { projectId: 'P_1', statusFieldId: 'F_1', statusOptions: { done: 'DONE' } },
      'I_1',
      'done',
    );
    expect(transport.calls).toHaveLength(1);
    expect(String(transport.calls[0]?.body?.query)).toMatch(/^query/u);
  });
});

describe('bounded gh transport', () => {
  it('uses argv and JSON stdin while preserving literal multiline text', async () => {
    const end = vi.fn();
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(
          null,
          'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"number":1}',
        );
        return { stdin: { on: vi.fn(), end } };
      },
    );
    const transport = createGhTransport({ cwd: '/repository', timeoutMs: 1234 });
    const body = { title: '$(do-not-run)', body: 'First\n`second`' };
    expect(await transport.request({ method: 'POST', path: `${prefix}/issues`, body })).toEqual({
      number: 1,
    });
    expect(execFileMock).toHaveBeenLastCalledWith(
      'gh',
      [
        'api',
        '--include',
        '--method',
        'POST',
        `${prefix}/issues`,
        '-H',
        'Accept: application/vnd.github+json',
        '-H',
        'X-GitHub-Api-Version: 2022-11-28',
        '--input',
        '-',
      ],
      expect.objectContaining({ cwd: '/repository', timeout: 1234, killSignal: 'SIGKILL' }),
      expect.any(Function),
    );
    expect(end).toHaveBeenCalledWith(JSON.stringify(body));
  });

  it.each([
    ['HTTP/2.0 422 Unprocessable Entity\n\n{}', 'rejected'],
    ['HTTP/2.0 503 Service Unavailable\n\n{}', 'unknown'],
    ['', 'unknown'],
  ])('classifies failed transport without leaking response details', async (stdout, outcome) => {
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(new Error('private account details'), stdout);
        return { stdin: { on: vi.fn(), end: vi.fn() } };
      },
    );
    const transport = createGhTransport({ cwd: '/repository' });
    await expect(
      transport.request({ method: 'POST', path: `${prefix}/issues` }),
    ).rejects.toMatchObject({
      outcome,
      message: expect.not.stringContaining('private account') as unknown,
    });
  });

  it('rejects unbounded transport limits', () => {
    expect(() => createGhTransport({ cwd: '/repository', timeoutMs: Infinity })).toThrow(
      'finite positive bounds',
    );
  });

  it.each([
    ['Retry-After: 120', 429, 120_000],
    ['Retry-After: Thu, 01 Jan 1970 00:03:00 GMT', 403, 180_000],
    ['X-RateLimit-Remaining: 0\nX-RateLimit-Reset: 180', 403, 180_000],
    ['X-RateLimit-Remaining: 0\nX-RateLimit-Reset: 180', 200, 180_000],
    ['Retry-After: NaN\nX-RateLimit-Reset: Infinity', 429, 60_000],
    ['Retry-After: 120', 503, 120_000],
  ])('reads bounded backoff from headers %s', (headers, status, expected) => {
    expect(githubRateLimitBackoff(headers, status, 0)).toBe(expected);
    expect(githubRateLimitBackoff('X-RateLimit-Remaining: 1', 200, 0)).toBeUndefined();
  });

  it('persists throttling across transports and admits a later request without replaying a mutation', async () => {
    let now = 1000;
    let backoff: number | undefined;
    execFileMock.mockClear();
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(new Error('throttled'), 'HTTP/2.0 429 Too Many Requests\nRetry-After: 120\n\n{}');
        return { stdin: { on: vi.fn(), end: vi.fn() } };
      },
    );
    const options = {
      cwd: '/repository',
      now: () => now,
      readBackoffUntil: () => backoff,
      writeBackoffUntil: (value: number) => {
        backoff = value;
      },
    };
    await expect(
      createGhTransport(options).request({ method: 'POST', path: `${prefix}/issues` }),
    ).rejects.toMatchObject({ outcome: 'rejected', retryAtMs: 121_000 });
    expect(backoff).toBe(121_000);
    await expect(
      createGhTransport(options).request({ method: 'GET', path: `${prefix}/issues` }),
    ).rejects.toMatchObject({ retryAtMs: 121_000 });
    expect(execFileMock).toHaveBeenCalledTimes(1);
    now = 121_000;
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(null, 'HTTP/2.0 200 OK\nX-RateLimit-Remaining: 0\nX-RateLimit-Reset: 240\n\n[]');
        return { stdin: { on: vi.fn(), end: vi.fn() } };
      },
    );
    await expect(
      createGhTransport(options).request({ method: 'GET', path: `${prefix}/issues` }),
    ).resolves.toEqual([]);
    expect(backoff).toBe(240_000);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it('rechecks authority immediately before a write following its preliminary marker read', async () => {
    let authorized = true;
    execFileMock.mockClear();
    execFileMock.mockImplementation(
      (
        _file: string,
        _args: string[],
        _options: unknown,
        callback: (error: Error | null, stdout: string) => void,
      ) => {
        callback(null, `HTTP/2.0 200 OK\n\n${JSON.stringify(issue(1))}`);
        authorized = false;
        return { stdin: { on: vi.fn(), end: vi.fn() } };
      },
    );
    const transport = createGhTransport({
      cwd: '/repository',
      beforeRequest: () => {
        if (!authorized) {
          throw new Error('authority-revoked');
        }
      },
    });
    const github = new DeliveryGitHub({ repository, transport });
    await expect(github.updateIssue(1, { body: 'Updated body' })).rejects.toThrow(
      'authority-revoked',
    );
    expect(execFileMock).toHaveBeenCalledOnce();
    expect(execFileMock.mock.calls[0]?.[1]).toContain('GET');
  });
});

describe('frozen workflow producer provenance', () => {
  it('includes local GitHub actions in the frozen subtree and rejects truncated trees', async () => {
    const transport = new FakeTransport((request) => {
      if (request.path.endsWith('/git/trees/current')) {
        return { truncated: false, tree: [{ path: '.github', type: 'tree', sha: 'github-tree' }] };
      }
      return { truncated: true, tree: [] };
    });
    const client = new DeliveryGitHub({ repository, transport });
    await expect(client.getWorkflowTreeSha('current')).resolves.toBe('github-tree');
    await expect(client.getWorkflowTreeSha('unknown')).rejects.toThrow('incomplete');
  });

  it('rejects mutable action tags and local actions outside frozen GitHub content', async () => {
    const transport = new FakeTransport((request) => {
      if (request.path.includes('/git/trees/')) {
        return {
          truncated: false,
          tree: [{ type: 'blob', path: 'workflows/check.yml', sha: 'blob' }],
        };
      }
      return {
        encoding: 'base64',
        content: Buffer.from(
          'jobs:\n  check:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./candidate-action\n      - uses: ./.github/actions/../../candidate-action\n',
        ).toString('base64'),
      };
    });
    const client = new DeliveryGitHub({ repository, transport });
    await expect(client.assessWorkflowProvenance('tree')).resolves.toHaveLength(3);
  });

  it('admits immutable external refs and contained local actions', async () => {
    const transport = new FakeTransport((request) => {
      if (request.path.includes('/git/trees/')) {
        return {
          truncated: false,
          tree: [{ type: 'blob', path: 'workflows/check.yml', sha: 'blob' }],
        };
      }
      return {
        encoding: 'base64',
        content: Buffer.from(
          `jobs:\n  check:\n    steps:\n      - uses: actions/checkout@${'a'.repeat(40)}\n      - uses: ./.github/actions/check\n`,
        ).toString('base64'),
      };
    });
    const client = new DeliveryGitHub({ repository, transport });
    await expect(client.assessWorkflowProvenance('tree')).resolves.toEqual([]);
  });

  it('rejects a frozen action manifest symlink that could resolve to mutable candidate content', async () => {
    const transport = new FakeTransport((request) =>
      request.path.includes('/git/trees/')
        ? {
            truncated: false,
            tree: [{ type: 'blob', mode: '120000', path: 'actions/check/action.yml', sha: 'blob' }],
          }
        : { encoding: 'base64', content: Buffer.from('../../../candidate.yml').toString('base64') },
    );
    const client = new DeliveryGitHub({ repository, transport });
    await expect(client.assessWorkflowProvenance('tree')).resolves.toContain(
      'Trusted GitHub producer content contains a symbolic link.',
    );
  });

  it('rejects a candidate that changes workflow producers or the active actor', async () => {
    const transport = new FakeTransport((request) => {
      if (request.path.endsWith('/git/trees/base-sha')) {
        return { truncated: false, tree: [{ path: '.github', type: 'tree', sha: 'trusted' }] };
      }
      if (request.path.endsWith('/git/trees/head-sha')) {
        return { truncated: false, tree: [{ path: '.github', type: 'tree', sha: 'changed' }] };
      }
      if (request.path === 'user') {
        return { login: 'other' };
      }
      if (request.path.endsWith('/pulls/1')) {
        return pullRequest();
      }
      if (request.path.includes('/check-runs')) {
        return { check_runs: [] };
      }
      return prerequisiteResponse(request);
    });
    const client = new DeliveryGitHub({ repository, transport });
    const assessment = await client.assessCandidate({
      number: 1,
      expectedHeadSha: 'head-sha',
      expectedBaseSha: 'base-sha',
      workflowTreeSha: 'trusted',
      actor: 'operator',
      checks: required,
    });
    expect(assessment.allowed).toBe(false);
    expect(assessment.blockers).toContain(
      'The candidate changed trusted workflow producer definitions.',
    );
    expect(assessment.blockers).toContain('The delivery GitHub actor changed.');
  });
});
