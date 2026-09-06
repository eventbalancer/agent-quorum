import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { SpawnOptions } from 'node:child_process';
import { finished } from 'node:stream/promises';
import { StringDecoder } from 'node:string_decoder';
import {
  assertExecutionAllowed,
  spawnControlled,
  type ExecutionControl,
} from '../runtime/execution-control.js';
import { terminateOwned, waitForExit } from '../runtime/exec.js';
import { contentDigest, DeliveryError, digest, type Mandate } from './contract.js';
import type { DeliveryLedger, EffectRecord } from './ledger.js';
import { dockerExecutorArgs } from './confined-executor.js';
import { frozenGateArgs } from './gate-toolchain.js';
import { assertFrozenVerificationPolicy } from './verification-policy.js';
import { completeDeliveryWorktree } from './worktree-finalization.js';
import {
  providerChannel,
  PROVIDER_MESSAGE_BYTES,
  type ProviderRequestHandler,
} from './provider-channel.js';

// Leave room for host/VM clock skew below both container guards' 500 ms ceiling.
const OWNER_HEARTBEAT_LEASE_MS = 400;
const OWNER_HEARTBEAT_INTERVAL_MS = 100;

interface DeliveryWorktree {
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
}

interface WorktreeIntent extends DeliveryWorktree {
  readonly key: string;
  readonly slug: string;
}

function recordedWorktreeIntent(effect: EffectRecord, issue: number): WorktreeIntent {
  const input = effect.input;
  if (
    effect.kind !== 'branch' ||
    effect.issue !== issue ||
    !['intended', 'unknown', 'completed'].includes(effect.state) ||
    typeof input !== 'object' ||
    input === null ||
    !('worktree' in input) ||
    typeof input.worktree !== 'string' ||
    !('branch' in input) ||
    typeof input.branch !== 'string' ||
    !new RegExp(`^session/delivery-${issue}-[a-f0-9]{10}$`, 'u').test(input.branch) ||
    !('base' in input) ||
    typeof input.base !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(input.base)
  ) {
    throw new DeliveryError('worktree-intent-invalid');
  }
  const slug = input.branch.slice('session/'.length);
  const worktree = path.join(os.homedir(), '.agent-quorum/worktrees/agent-quorum', slug);
  if (input.worktree !== worktree || effect.key !== `worktree:${issue}:${input.branch}`) {
    throw new DeliveryError('worktree-intent-invalid');
  }
  if (effect.state === 'completed' || effect.output !== undefined) {
    const output = effect.output;
    if (
      typeof output !== 'object' ||
      output === null ||
      !('worktree' in output) ||
      output.worktree !== worktree ||
      !('branch' in output) ||
      output.branch !== input.branch
    ) {
      throw new DeliveryError('worktree-intent-output-mismatch');
    }
  }
  return { key: effect.key, slug, worktree, branch: input.branch, baseSha: input.base };
}

export interface CommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly execution: ExecutionControl;
  readonly env?: NodeJS.ProcessEnv;
  readonly input?: string;
  readonly keepAlive?: boolean;
  readonly providerRequests?: ProviderRequestHandler;
}

export async function runDeliveryCommand(input: CommandInput): Promise<CommandResult> {
  const options: SpawnOptions = {
    cwd: input.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: input.env ?? process.env,
  };
  const child = await spawnControlled(input.command, input.args, options, input.execution);
  const completion = waitForExit(child);
  let stdout = '';
  let stderr = '';
  const output = { exceeded: false };
  const channel =
    input.providerRequests === undefined
      ? undefined
      : providerChannel(input.providerRequests, (value) => {
          child.stdin?.write(`${JSON.stringify(value)}\n`);
        });
  let framed = '';
  const decoder = new StringDecoder('utf8');
  const receive = (stream: 'stdout' | 'stderr', chunk: Buffer) => {
    if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) + chunk.length > 8 * 1024 * 1024) {
      output.exceeded = true;
      void terminateOwned(child, 0);
      return;
    }
    if (stream === 'stdout') {
      stdout += chunk.toString();
    } else {
      stderr += chunk.toString();
    }
  };
  child.stdout?.on('data', (chunk: Buffer) => {
    if (channel === undefined) {
      receive('stdout', chunk);
      return;
    }
    framed += decoder.write(chunk);
    if (Buffer.byteLength(framed) > PROVIDER_MESSAGE_BYTES) {
      output.exceeded = true;
      void terminateOwned(child, 0);
      return;
    }
    for (let newline = framed.indexOf('\n'); newline >= 0; newline = framed.indexOf('\n')) {
      const line = framed.slice(0, newline);
      framed = framed.slice(newline + 1);
      if (!channel.consume(line)) {
        receive('stdout', Buffer.from(`${line}\n`));
      }
    }
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    receive('stderr', chunk);
  });
  child.stdin?.on('error', () => undefined);
  let heartbeat: NodeJS.Timeout | undefined;
  if (input.keepAlive === true) {
    const deadlineEpochMs = input.execution.deadlineEpochMs;
    if (deadlineEpochMs === undefined) {
      await terminateOwned(child, 0);
      throw new DeliveryError('container-deadline-required', true);
    }
    const ping = () => {
      const validUntilEpochMs = Math.min(deadlineEpochMs, Date.now() + OWNER_HEARTBEAT_LEASE_MS);
      child.stdin?.write(`${JSON.stringify({ deadlineEpochMs, validUntilEpochMs })}\n`);
    };
    ping();
    heartbeat = setInterval(ping, OWNER_HEARTBEAT_INTERVAL_MS);
  } else {
    child.stdin?.end(input.input);
  }
  const drained = [child.stdout, child.stderr]
    .filter((stream) => stream !== null)
    .map((stream) => finished(stream).catch(() => undefined));
  const exitCode = await completion;
  await channel?.close();
  clearInterval(heartbeat);
  child.stdin?.end();
  await Promise.all(drained);
  if (framed !== '') {
    receive('stdout', Buffer.from(framed));
  }
  assertExecutionAllowed(input.execution);
  if (output.exceeded) {
    throw new DeliveryError('command-output-limit');
  }
  return { exitCode, stdout, stderr };
}

function trustedSearchPath(): string {
  return [
    path.dirname(process.execPath),
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
  ].join(path.delimiter);
}

export interface BrokerCredential {
  readonly token: string;
}

export function brokerEnvironment(credential?: BrokerCredential): NodeJS.ProcessEnv {
  return {
    PATH: trustedSearchPath(),
    HOME: os.homedir(),
    LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...(credential === undefined
      ? { GH_TOKEN: process.env.GH_TOKEN, GITHUB_TOKEN: process.env.GITHUB_TOKEN }
      : { GH_TOKEN: credential.token }),
  };
}

export function repositoryEnvironment(
  scratch: string,
  extra: NodeJS.ProcessEnv = {},
): NodeJS.ProcessEnv {
  return {
    PATH: trustedSearchPath(),
    HOME: path.join(scratch, 'home'),
    LANG: 'en_US.UTF-8',
    TMPDIR: scratch,
    CI: '1',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

export function sandboxPolicy(
  worktree: string,
  scratch: string,
  ledgerDirectory: string,
  sourceRoot: string,
  runtimeRoot?: string,
): string {
  const quoted = (value: string) =>
    JSON.stringify(existsSync(value) ? realpathSync(value) : path.resolve(value));
  const readable = [
    '/System/Library',
    '/usr/lib',
    '/usr/share',
    '/usr/bin',
    '/bin',
    '/sbin',
    '/usr/sbin',
    '/Library/Apple',
    '/private/var/db/dyld',
    '/private/var/db/timezone',
    path.dirname(path.dirname(realpathSync(process.execPath))),
    worktree,
    scratch,
    ...(runtimeRoot === undefined ? [] : [runtimeRoot]),
  ];
  const denied = [
    ledgerDirectory,
    path.join(os.homedir(), '.ssh'),
    path.join(os.homedir(), '.codex'),
    path.join(os.homedir(), '.claude'),
    path.join(os.homedir(), '.config/gh'),
    path.join(os.homedir(), '.npmrc'),
    path.join(sourceRoot, '.git'),
  ];
  return [
    '(version 1)',
    '(deny default)',
    '(allow process-exec)',
    '(allow process-fork)',
    '(allow signal (target self))',
    '(allow sysctl-read)',
    '(allow file-read-metadata)',
    '(allow mach-lookup (global-name "com.apple.system.logger") (global-name "com.apple.system.opendirectoryd.libinfo"))',
    ...readable.map((directory) => `(allow file-read* (subpath ${quoted(directory)}))`),
    '(allow file-read* (literal "/") (literal "/private/etc/localtime") (literal "/private/etc/hosts") (literal "/dev/null") (literal "/dev/random") (literal "/dev/urandom") (subpath "/dev/fd"))',
    ...denied.map((directory) => `(deny file-read* (subpath ${quoted(directory)}))`),
    `(allow file-write* (subpath ${quoted(worktree)}) (subpath ${quoted(scratch)}) (literal "/dev/null"))`,
    `(deny file-write* (subpath ${quoted(path.join(worktree, '.git'))}))`,
  ].join('\n');
}

export class RepositoryBroker {
  readonly #credential: BrokerCredential | undefined;

  constructor(
    readonly ledger: DeliveryLedger,
    readonly mandate: Mandate,
    readonly execution: ExecutionControl,
    credential?: BrokerCredential,
  ) {
    if (
      credential !== undefined &&
      (credential.token === '' ||
        credential.token.length > 16384 ||
        /[\s\0]/u.test(credential.token))
    ) {
      throw new DeliveryError('invalid-broker-credential', true);
    }
    this.#credential =
      credential === undefined ? undefined : Object.freeze({ token: credential.token });
  }

  private commandExecution(env: NodeJS.ProcessEnv): ExecutionControl {
    return {
      ...this.execution,
      env,
      attemptTimeoutMs: this.mandate.profile.bounds.commandTimeoutMs,
      deadlineEpochMs: Math.min(
        this.execution.deadlineEpochMs ?? Infinity,
        Date.now() + this.mandate.profile.bounds.commandTimeoutMs,
      ),
    };
  }

  async finalizeWorktree(worktree: string, issue: number): Promise<void> {
    await completeDeliveryWorktree(
      this.ledger,
      this.mandate,
      this.commandExecution(brokerEnvironment(this.#credential)),
      worktree,
      issue,
    );
  }

  async git(
    cwd: string,
    args: readonly string[],
    issue: number,
    mutation = false,
    input?: string,
  ): Promise<string> {
    return this.runGit(cwd, args, issue, mutation, input);
  }

  private async runGit(
    cwd: string,
    args: readonly string[],
    issue: number,
    mutation: boolean,
    input?: string,
    trustedHooks?: string,
  ): Promise<string> {
    this.ledger.assertAuthorized(mutation ? 'commit' : 'verify', issue);
    const isForbidden =
      args.some((arg) =>
        ['--no-verify', '--force', '--force-with-lease', '--hard', '--tags', '--admin'].includes(
          arg,
        ),
      ) ||
      (![
        'status',
        'diff',
        'ls-files',
        'rev-parse',
        'log',
        'branch',
        'fetch',
        'ls-remote',
        'merge-base',
        'merge',
        'push',
        'add',
        'commit',
      ].includes(args[0] ?? '') &&
        args.join(' ') !== 'worktree list --porcelain' &&
        !(
          args.length === 2 &&
          args[0] === 'show' &&
          /^[a-f0-9]{40}:package\.json$/.test(args[1] ?? '')
        ));
    if (isForbidden) {
      throw new DeliveryError('forbidden-git-operation', true);
    }
    if (mutation) {
      assertFrozenVerificationPolicy(this.mandate, cwd);
      const owned = this.ledger.issue(issue)?.worktree;
      if (owned === undefined || realpathSync(owned) !== realpathSync(cwd)) {
        throw new DeliveryError('git-mutation-outside-owned-worktree', true);
      }
    }
    const hooks = trustedHooks ?? path.join(this.ledger.directory, 'empty-hooks');
    mkdirSync(hooks, { recursive: true, mode: 0o700 });
    const env = brokerEnvironment(this.#credential);
    const execution = this.commandExecution(env);
    const security = [
      '-c',
      `core.hooksPath=${hooks}`,
      '-c',
      'core.fsmonitor=false',
      '-c',
      'core.attributesFile=/dev/null',
      '-c',
      'diff.external=',
      '-c',
      'core.pager=cat',
      '-c',
      'credential.helper=',
      '-c',
      'credential.helper=!gh auth git-credential',
      '-c',
      'credential.interactive=false',
      '-c',
      'protocol.allow=never',
      '-c',
      'protocol.https.allow=always',
      '-c',
      'remote.origin.url=https://github.com/eventbalancer/agent-quorum.git',
      '-c',
      'remote.origin.pushurl=https://github.com/eventbalancer/agent-quorum.git',
      '-c',
      `user.name=${this.mandate.actor}`,
      '-c',
      `user.email=${this.mandate.actor}@users.noreply.github.com`,
    ];
    const configuredCommands = await runDeliveryCommand({
      command: '/usr/bin/git',
      args: [
        ...security,
        'config',
        '--local',
        '--includes',
        '--name-only',
        '--get-regexp',
        '^(filter\\..*\\.(clean|smudge|process)|merge\\..*\\.driver|url\\..*\\.(insteadof|pushinsteadof)|credential(\\..*)?\\.helper|http(\\..*)?\\.proxy)$',
      ],
      cwd,
      execution,
      env,
    });
    if (configuredCommands.exitCode !== 1 || configuredCommands.stdout.trim() !== '') {
      throw new DeliveryError('repository-external-git-command-configured', true);
    }
    const boundedArgs =
      args[0] === 'diff' ? ['diff', '--no-ext-diff', '--no-textconv', ...args.slice(1)] : args;
    const result = await runDeliveryCommand({
      command: '/usr/bin/git',
      args: [...security, ...boundedArgs],
      cwd,
      execution,
      env,
      ...(input === undefined ? {} : { input }),
    });
    if (result.exitCode !== 0) {
      throw new DeliveryError('git-operation-failed');
    }
    return result.stdout.trim();
  }

  async verify(worktree: string, args: readonly string[], issue: number): Promise<CommandResult> {
    this.ledger.assertAuthorized('verify', issue);
    assertFrozenVerificationPolicy(this.mandate, worktree);
    const allowed = [
      'check',
      'test',
      'test:coverage',
      'build',
      'types:check',
      'lint:check',
      'format:check',
    ];
    const isScript = args[0] === 'run' && allowed.includes(args[1] ?? '');
    const isInstall = [
      'install --frozen-lockfile --offline --ignore-scripts',
      'install --lockfile-only --offline --ignore-scripts',
    ].includes(args.join(' '));
    if (!isScript && !isInstall) {
      throw new DeliveryError('repository-command-not-approved');
    }
    if (
      args
        .slice(2)
        .some(
          (arg) => arg.startsWith('-') || !/^tests\/[a-zA-Z0-9/_.-]+\.test\.[cm]?[jt]s$/.test(arg),
        )
    ) {
      if (!isInstall) {
        throw new DeliveryError('invalid-targeted-test-path');
      }
    }
    const executor = this.mandate.profile.executor;
    if (executor !== undefined) {
      const env = { PATH: trustedSearchPath(), HOME: os.homedir(), LANG: 'en_US.UTF-8' };
      return runDeliveryCommand({
        command: 'docker',
        args: dockerExecutorArgs(
          { image: executor.image, worktree, runtimeRoot: this.mandate.runtimeRoot },
          isInstall
            ? ['pnpm', ...args]
            : frozenGateArgs('/aq-harness', '/aq-toolchain', worktree, args),
        ),
        cwd: this.mandate.runtimeRoot,
        execution: this.commandExecution(env),
        env,
        keepAlive: true,
      });
    }
    if (process.platform !== 'darwin') {
      throw new DeliveryError('delivery-sandbox-unavailable', true);
    }
    const scratch = mkdtempSync(path.join(os.tmpdir(), 'aq-delivery-check-'));
    const policy = sandboxPolicy(
      worktree,
      scratch,
      this.ledger.directory,
      this.mandate.sourceRoot,
      this.mandate.runtimeRoot,
    );
    const env = repositoryEnvironment(scratch, { npm_config_cache: path.join(scratch, 'npm') });
    mkdirSync(env.HOME ?? path.join(scratch, 'home'), { mode: 0o700 });
    try {
      return await runDeliveryCommand({
        command: '/usr/bin/sandbox-exec',
        args: [
          '-p',
          policy,
          ...(isInstall
            ? ['pnpm', ...args]
            : frozenGateArgs(this.mandate.runtimeRoot, this.mandate.runtimeRoot, worktree, args)),
        ],
        cwd: worktree,
        execution: this.commandExecution(env),
        env,
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  }

  async treeDigest(worktree: string, issue: number): Promise<string> {
    const files = (
      await this.git(
        worktree,
        ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
        issue,
      )
    )
      .split('\0')
      .filter(Boolean)
      .sort();
    const entries = files.map((file) => {
      const absolute = path.join(worktree, file);
      if (!existsSync(absolute)) {
        return { file, deleted: true };
      }
      const stat = lstatSync(absolute);
      return {
        file,
        mode: stat.mode & 0o777,
        digest: contentDigest(
          stat.isSymbolicLink() ? readlinkSync(absolute) : readFileSync(absolute),
        ),
      };
    });
    return digest(entries);
  }

  async changedPaths(worktree: string, base: string, issue: number): Promise<string[]> {
    const tracked = await this.git(worktree, ['diff', '--name-only', base, '--'], issue);
    const untracked = await this.git(
      worktree,
      ['ls-files', '--others', '--exclude-standard'],
      issue,
    );
    return [...new Set(`${tracked}\n${untracked}`.split('\n').filter(Boolean))].sort();
  }

  async createWorktree(issue: number, base: string, effectKey?: string): Promise<DeliveryWorktree> {
    this.ledger.assertAuthorized('branch', issue);
    const recorded = this.ledger.effects().filter((effect) => {
      return (
        (effect.issue === issue && effect.kind === 'branch') ||
        effect.key.startsWith(`worktree:${issue}:`)
      );
    });
    if (recorded.length > 1) {
      throw new DeliveryError('worktree-ownership-ambiguous');
    }
    const prior = recorded[0];
    if (effectKey !== undefined && prior?.key !== effectKey) {
      throw new DeliveryError('worktree-intent-identity-mismatch');
    }
    const freshSlug = `delivery-${issue}-${digest(this.mandate).slice(0, 10)}`;
    const intent = recordedWorktreeIntent(
      prior ?? {
        key: `worktree:${issue}:session/${freshSlug}`,
        kind: 'branch',
        issue,
        state: 'intended',
        input: {
          worktree: path.join(os.homedir(), '.agent-quorum/worktrees/agent-quorum', freshSlug),
          branch: `session/${freshSlug}`,
          base,
        },
      },
      issue,
    );
    const { key, slug, worktree, branch, baseSha } = intent;
    const current = this.ledger.issue(issue);
    if (
      (current?.worktree !== undefined && current.worktree !== worktree) ||
      (current?.branch !== undefined && current.branch !== branch)
    ) {
      throw new DeliveryError('worktree-ownership-ambiguous');
    }
    if (existsSync(worktree)) {
      if (prior === undefined) {
        throw new DeliveryError('worktree-ownership-ambiguous');
      }
    } else {
      if (prior?.state === 'completed' || current?.worktree !== undefined) {
        throw new DeliveryError('recorded-worktree-missing');
      }
      this.ledger.intendEffect({
        key,
        kind: 'branch',
        issue,
        state: 'intended',
        input: { worktree, branch, base: baseSha },
      });
      await this.git(this.mandate.sourceRoot, ['fetch', 'origin', 'main'], issue);
      if (
        prior === undefined &&
        (await this.git(this.mandate.sourceRoot, ['rev-parse', 'origin/main'], issue)) !== baseSha
      ) {
        throw new DeliveryError('base-changed-before-worktree');
      }
      if (
        (await this.git(this.mandate.sourceRoot, ['rev-parse', `${baseSha}^{commit}`], issue)) !==
        baseSha
      ) {
        throw new DeliveryError('worktree-base-unavailable');
      }
      const hooks = path.join(this.ledger.directory, 'empty-hooks');
      mkdirSync(hooks, { recursive: true, mode: 0o700 });
      const env = {
        ...brokerEnvironment(this.#credential),
        AGENT_QUORUM_WORKTREE_REPOSITORY_ROOT: this.mandate.sourceRoot,
        AGENT_QUORUM_WORKTREE_SKIP_INSTALL: '1',
        GIT_CONFIG_COUNT: '2',
        GIT_CONFIG_KEY_0: 'core.hooksPath',
        GIT_CONFIG_VALUE_0: hooks,
        GIT_CONFIG_KEY_1: 'core.fsmonitor',
        GIT_CONFIG_VALUE_1: 'false',
      };
      this.ledger.assertAuthorized('branch', issue);
      const creation = await runDeliveryCommand({
        command: 'pnpm',
        args: [
          'run',
          'worktree:create',
          slug,
          '--desc',
          `Autonomous delivery of issue #${issue}`,
          '--from',
          baseSha,
        ],
        cwd: this.mandate.runtimeRoot,
        execution: this.commandExecution(env),
        env,
      });
      if (creation.exitCode !== 0) {
        throw new DeliveryError('worktree-creation-failed');
      }
      await runDeliveryCommand({
        command: 'pnpm',
        args: ['run', 'worktree:open', slug],
        cwd: this.mandate.runtimeRoot,
        execution: this.commandExecution(env),
        env,
      });
    }
    await this.assertWorktreeOwnership(intent, issue);
    this.ledger.assertAuthorized('branch', issue);
    this.ledger.finishEffect(key, 'completed', { worktree, branch });
    return { worktree, branch, baseSha };
  }

  private async assertWorktreeOwnership(intent: WorktreeIntent, issue: number): Promise<void> {
    const { worktree, branch, baseSha } = intent;
    if (
      !lstatSync(worktree).isDirectory() ||
      !lstatSync(path.join(worktree, '.git')).isFile() ||
      (await this.git(worktree, ['branch', '--show-current'], issue)) !== branch ||
      realpathSync(await this.git(worktree, ['rev-parse', '--show-toplevel'], issue)) !==
        realpathSync(worktree)
    ) {
      throw new DeliveryError('worktree-ownership-ambiguous');
    }
    const commonArgs = ['rev-parse', '--path-format=absolute', '--git-common-dir'];
    const common = await this.git(worktree, commonArgs, issue);
    const sourceCommon = await this.git(this.mandate.sourceRoot, commonArgs, issue);
    if (
      realpathSync(common) !== realpathSync(sourceCommon) ||
      (await this.git(worktree, ['merge-base', baseSha, 'HEAD'], issue)) !== baseSha
    ) {
      throw new DeliveryError('worktree-ownership-ambiguous');
    }
    const admin = await this.git(worktree, ['rev-parse', '--absolute-git-dir'], issue);
    const registeredGitFile = readFileSync(path.join(admin, 'gitdir'), 'utf8').trim();
    if (realpathSync(registeredGitFile) !== realpathSync(path.join(worktree, '.git'))) {
      throw new DeliveryError('worktree-ownership-ambiguous');
    }
  }

  async commit(
    worktree: string,
    issue: number,
    message: string,
    identity: string,
  ): Promise<string> {
    this.ledger.assertAuthorized('commit', issue);
    if (
      !/^(?:feat|fix|refactor|docs|test|chore|perf|ci|build|revert)(?:\([a-z0-9-]+\))?: [a-z0-9][ -~]*$/.test(
        message,
      ) ||
      message.length > 72 ||
      message.endsWith('.')
    ) {
      throw new DeliveryError('invalid-delivery-commit-message');
    }
    const key = `commit:${issue}:${identity}`;
    const previous = this.ledger.effect(key);
    const existing = await this.git(worktree, ['log', '-30', '--format=%H%n%B'], issue);
    const lines = existing.split('\n');
    const marker = `Delivery-Operation: ${key}`;
    const markerIndex = lines.indexOf(marker);
    if (markerIndex >= 0) {
      const sha = lines
        .slice(0, markerIndex)
        .reverse()
        .find((line) => /^[a-f0-9]{40}$/.test(line));
      if (sha !== undefined) {
        this.ledger.finishEffect(key, 'completed', { sha });
        return sha;
      }
    }
    if (previous !== undefined) {
      throw new DeliveryError('uncertain-commit-requires-reconciliation');
    }
    this.ledger.intendEffect({
      key,
      kind: 'commit',
      issue,
      state: 'intended',
      input: { identity, message },
    });
    const hooks = path.join(this.ledger.directory, 'hooks');
    mkdirSync(hooks, { recursive: true, mode: 0o700 });
    const hook = path.join(hooks, 'pre-commit');
    const quoted = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
    const content = `#!/bin/sh\nexec ${quoted(process.execPath)} ${quoted(path.join(this.mandate.runtimeRoot, 'dist/delivery/main.js'))} internal-hook --state-dir ${quoted(this.ledger.directory)} --issue ${issue}\n`;
    writeFileSync(hook, content, { mode: 0o700 });
    await this.git(worktree, ['add', '--all'], issue, true);
    const body = `${message}\n\nCloses #${issue}\n\n${marker}\n`;
    await this.runGit(worktree, ['commit', '--file=-'], issue, true, body, hooks);
    const sha = await this.git(worktree, ['rev-parse', 'HEAD'], issue);
    this.ledger.finishEffect(key, 'completed', { sha });
    return sha;
  }
}
