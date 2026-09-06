import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readExecutionHandoff } from '../runtime/execution-handoff.js';
import {
  activateDelivery,
  installDeliveryLaunchAgent,
  prepareDelivery,
  runActivationProbes,
  verifyFrozenRuntime,
  verifyProviderConfinement,
} from './activation.js';
import { RepositoryBroker } from './commands.js';
import {
  DeliveryError,
  digest,
  parseDeliveryProfile,
  scopeExpands,
  scopeIncludes,
  type DeliveryIssue,
  type IssueStage,
} from './contract.js';
import { checkSharedMainRecovery } from './main-recovery.js';
import { runDeliveryStep } from './controller.js';
import {
  acquireRepositoryOwner,
  awaitOwnedDeliveryStop,
  currentProcessOwner,
  deliveryStateDirectory,
  runDeliveryGuardian,
  stopOwnedDeliveryWork,
} from './guardian.js';
import { DeliveryLedger } from './ledger.js';

const HELP = `Repository-local autonomous delivery

  prepare --profile <json> [--root <checkout>] [--state-dir <directory>]
  activate --digest <prepared-digest> [--state-dir <directory>]
  status | events [--after <sequence>] [--acknowledge <sequence>] [--state-dir <directory>]
  pause | stop | resume | revoke [--state-dir <directory>]
  scope --scope <json> [--authorize <current-digest>] [--state-dir <directory>]
  reopen --issue <number> --active-minutes <minutes> --repairs <count>
         --authorize <current-digest> [--operation-id <id>] [--provider-starts <count>]
         [--design-runs <count>] [--live-starts <count>] [--state-dir <directory>]

Preparation does not activate delivery. Activation authorizes bounded capability
probes and enables delivery only after all prerequisites pass. Releases remain manual.
`;

export interface DeliveryArguments {
  readonly command: string;
  readonly options: Readonly<Record<string, string>>;
}

export function parseDeliveryArguments(input: readonly string[]): DeliveryArguments {
  const args = input[0] === '--' ? input.slice(1) : input;
  const command = args[0] ?? 'help';
  const accepted: Record<string, readonly string[]> = {
    help: [],
    '--help': [],
    prepare: ['profile', 'root'],
    activate: ['digest'],
    status: [],
    events: ['after', 'acknowledge'],
    pause: [],
    stop: [],
    resume: [],
    revoke: [],
    scope: ['scope', 'authorize'],
    reopen: [
      'issue',
      'active-minutes',
      'repairs',
      'authorize',
      'operation-id',
      'provider-starts',
      'design-runs',
      'live-starts',
    ],
    'internal-step': [],
    'internal-hook': ['issue'],
    'internal-probe': ['digest'],
    'internal-recovery': ['digest'],
    daemon: [],
  };
  const allowed = accepted[command];
  if (allowed === undefined) {
    throw new DeliveryError('unknown-delivery-command', true);
  }
  const options: Record<string, string> = {};
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (
      flag === undefined ||
      !flag.startsWith('--') ||
      value === undefined ||
      value.startsWith('--')
    ) {
      throw new DeliveryError('invalid-delivery-arguments', true);
    }
    const name = flag.slice(2);
    if ((!allowed.includes(name) && name !== 'state-dir') || options[name] !== undefined) {
      throw new DeliveryError('unsupported-or-duplicate-delivery-option', true);
    }
    options[name] = value;
  }
  return { command, options };
}

function requiredOption(options: Readonly<Record<string, string>>, name: string): string {
  const value = options[name];
  if (value === undefined || value === '') {
    throw new DeliveryError(`missing-delivery-option-${name}`, true);
  }
  return value;
}

function numericOption(options: Readonly<Record<string, string>>, name: string): number {
  const value = requiredOption(options, name);
  if (!/^\d+$/u.test(value)) {
    throw new DeliveryError(`invalid-delivery-option-${name}`, true);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) {
    throw new DeliveryError(`invalid-delivery-option-${name}`, true);
  }
  return number;
}

export function changeDeliveryScope(
  ledger: DeliveryLedger,
  scopeValue: unknown,
  authorization?: string,
): string {
  const previous = ledger.mandate();
  const profile = parseDeliveryProfile({ ...previous.profile, scope: scopeValue });
  const previousDigest = digest(previous);
  if (scopeExpands(previous.profile.scope, profile.scope) && authorization !== previousDigest) {
    throw new DeliveryError('scope-expansion-requires-current-authorization', true);
  }
  const next = { ...previous, profile, profileDigest: digest(profile) };
  const nextDigest = digest(next);
  ledger.transaction(() => {
    ledger.set('mandate', next);
    ledger.set('mandate-digest', nextDigest);
    const probes = ledger.get<Record<string, unknown>>('activation-probes');
    if (probes?.digest === previousDigest && probes.passed === true) {
      ledger.set('activation-probes', {
        ...probes,
        digest: nextDigest,
        inheritedFrom: previousDigest,
      });
    }
    ledger.event(
      'scope-changed',
      { digest: nextDigest, previousDigest, scope: profile.scope },
      true,
    );
  });
  const currentIssue = ledger.get<number>('current-issue') ?? 0;
  if (
    currentIssue !== 0 &&
    (profile.scope.exclude.includes(currentIssue) ||
      (profile.scope.include.length > 0 && !profile.scope.include.includes(currentIssue)))
  ) {
    stopOwnedDeliveryWork(ledger);
    const current = ledger.issue(currentIssue);
    if (current !== undefined) {
      ledger.set(`resume-stage:${currentIssue}`, current.stage);
      ledger.saveIssue({
        ...current,
        stage: 'deferred',
        blocker: 'scope-excluded',
        reconsiderWhen: 'explicit-scope-inclusion',
      });
      ledger.set('current-issue', 0);
    }
  }
  for (const issue of ledger.issues()) {
    if (
      issue.stage === 'deferred' &&
      issue.blocker === 'scope-excluded' &&
      scopeIncludes(profile.scope, issue.number)
    ) {
      ledger.set(
        `queued-reopen:${issue.number}`,
        ledger.get<IssueStage>(`resume-stage:${issue.number}`) ?? 'refine',
      );
    }
  }
  return nextDigest;
}

export function reopenDeliveryIssue(
  ledger: DeliveryLedger,
  issueNumber: number,
  activeMinutes: number,
  repairs: number,
  authorization: string,
  allowances: {
    readonly operationId?: string;
    readonly providerStarts?: number;
    readonly designRuns?: number;
    readonly liveStarts?: number;
  } = {},
): void {
  if (authorization !== digest(ledger.mandate())) {
    throw new DeliveryError('issue-reopen-requires-current-authorization', true);
  }
  if (!scopeIncludes(ledger.mandate().profile.scope, issueNumber)) {
    throw new DeliveryError('issue-reopen-outside-scope', true);
  }
  const issue = ledger.issue(issueNumber);
  if (issue?.stage !== 'deferred') {
    throw new DeliveryError('issue-is-not-deferred');
  }
  const grant = digest({
    authorization,
    issueNumber,
    operation: allowances.operationId ?? randomUUID(),
  });
  if (activeMinutes > 0 || repairs > 0) {
    ledger.grantIssue(issueNumber, activeMinutes * 60_000, repairs, grant);
  } else if (
    (allowances.providerStarts ?? 0) +
      (allowances.designRuns ?? 0) +
      (allowances.liveStarts ?? 0) <=
    0
  ) {
    throw new DeliveryError('issue-reopen-requires-positive-allowance', true);
  }
  for (const [kind, amount] of [
    ['provider', allowances.providerStarts ?? 0],
    ['design', allowances.designRuns ?? 0],
    ['live', allowances.liveStarts ?? 0],
  ] as const) {
    if (amount > 0) {
      ledger.grantAttempts(issueNumber, kind, amount, `${grant}:${kind}`);
    }
  }
  const stage = ledger.get<IssueStage>(`resume-stage:${issueNumber}`) ?? 'refine';
  const { blocker: _blocker, reconsiderWhen: _reconsiderWhen, ...preserved } = issue;
  const current = ledger.get<number>('current-issue') ?? 0;
  const reopened: DeliveryIssue = {
    ...preserved,
    stage: current === 0 || current === issueNumber ? stage : 'deferred',
  };
  ledger.transaction(() => {
    ledger.saveIssue(reopened);
    if (reopened.stage === 'deferred') {
      ledger.set(`queued-reopen:${issueNumber}`, stage);
    } else {
      ledger.set('current-issue', issueNumber);
    }
  });
  ledger.event(
    'issue-reopened',
    { issue: issueNumber, stage, previousBlocker: _blocker, previousCondition: _reconsiderWhen },
    true,
  );
}

export interface DeliveryCliHost {
  readonly output?: (value: unknown) => void;
  readonly prepare?: typeof prepareDelivery;
  readonly activate?: typeof activateDelivery;
  readonly install?: typeof installDeliveryLaunchAgent;
}

export async function runDeliveryCli(
  args: readonly string[],
  host: DeliveryCliHost = {},
): Promise<void> {
  const { command, options } = parseDeliveryArguments(args);
  const output =
    host.output ??
    ((value: unknown) =>
      process.stdout.write(
        `${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`,
      ));
  if (command === 'help' || command === '--help') {
    output(HELP);
    return;
  }
  const directory = path.resolve(options['state-dir'] ?? deliveryStateDirectory());
  const ledger = new DeliveryLedger(
    directory,
    command === 'status' || (command === 'events' && options.acknowledge === undefined),
  );
  const cancellation = new AbortController();
  const interrupt = () => {
    cancellation.abort();
  };
  process.once('SIGTERM', interrupt);
  process.once('SIGINT', interrupt);
  try {
    if (command === 'prepare') {
      const result = await (host.prepare ?? prepareDelivery)(ledger, {
        root: path.resolve(options.root ?? process.cwd()),
        profileFile: path.resolve(requiredOption(options, 'profile')),
        execution: { signal: cancellation.signal, deadlineEpochMs: Date.now() + 120_000 },
      });
      output({
        mode: ledger.mode(),
        digest: result.digest,
        blockers: result.blockers,
        profile: result.mandate.profile,
        exclusions: ['release operations', 'protection bypass', 'direct-to-main delivery'],
        stateDirectory: directory,
      });
    } else if (command === 'activate') {
      await (host.activate ?? activateDelivery)(ledger, requiredOption(options, 'digest'), {
        signal: cancellation.signal,
      });
      output({ mode: ledger.mode(), digest: digest(ledger.mandate()) });
    } else if (command === 'status') {
      const issue = ledger.get<number>('current-issue') ?? 0;
      output({
        mode: ledger.mode(),
        modeReason: ledger.modeReason(),
        executionAdmissionBlocker: ledger.get<unknown>('execution-admission-blocker'),
        digest: ledger.get<string>('mandate-digest'),
        currentIssue: issue,
        budget: ledger.budget(issue, Date.now()),
        sharedBlocker: ledger.get<unknown>('shared-blocker'),
        pendingEffects: ledger
          .effects()
          .filter((effect) => effect.state === 'unknown' || effect.state === 'intended')
          .map((effect) => ({
            key: effect.key,
            kind: effect.kind,
            issue: effect.issue,
            state: effect.state,
            inputDigest: digest(effect.input),
          })),
        nextWaitMs: ledger.get<number>('next-wait-ms') ?? 0,
        githubBackoffUntil: ledger.get<number>('github-backoff-until'),
        blockers: ledger.get<unknown>('activation-blockers') ?? [],
        work: ledger.issues().map((item) => ({
          number: item.number,
          stage: item.stage,
          worktree: item.worktree,
          pullRequest: item.pullRequest,
          blocker: item.blocker,
          receipt: item.receipt,
          candidateSha: item.candidateSha,
          mergedSha: item.mergedSha,
        })),
      });
    } else if (command === 'events') {
      if (options.acknowledge !== undefined) {
        ledger.acknowledge(numericOption(options, 'acknowledge'));
      }
      output(ledger.events(options.after === undefined ? 0 : numericOption(options, 'after')));
    } else if (command === 'pause' || command === 'stop' || command === 'revoke') {
      ledger.changeMode(
        command === 'pause' ? 'pausing' : command === 'stop' ? 'stopped' : 'revoked',
        'operator-request',
      );
      await awaitOwnedDeliveryStop(ledger);
      if (command === 'pause') {
        ledger.changeMode('paused', 'pause-acknowledged');
      }
      output({ mode: ledger.mode() });
    } else if (command === 'resume') {
      const mandate = ledger.mandate();
      if (
        !['paused', 'stopped', 'daily-limit', 'blocked'].includes(ledger.mode()) ||
        ledger.get<{ passed: boolean }>('activation-probes')?.passed !== true ||
        ledger.get<{ digest: string }>('activation-probes')?.digest !== digest(mandate)
      ) {
        throw new DeliveryError('resume-requires-previous-activation', true);
      }
      verifyFrozenRuntime(mandate);
      await awaitOwnedDeliveryStop(ledger);
      try {
        await (host.install ?? installDeliveryLaunchAgent)(mandate, ledger.directory, async () => {
          await awaitOwnedDeliveryStop(ledger);
          const release = acquireRepositoryOwner(currentProcessOwner());
          try {
            verifyFrozenRuntime(mandate);
            if (
              digest(ledger.mandate()) !== digest(mandate) ||
              !['paused', 'stopped', 'daily-limit', 'blocked'].includes(ledger.mode()) ||
              ledger.get<{ digest: string; passed: boolean }>('activation-probes')?.digest !==
                digest(mandate) ||
              ledger.get<{ passed: boolean }>('activation-probes')?.passed !== true
            ) {
              throw new DeliveryError('resume-authorization-changed', true);
            }
            ledger.changeMode('active', 'operator-resume');
          } finally {
            release();
          }
        });
      } catch {
        if (!['revoked', 'stopped', 'paused', 'pausing'].includes(ledger.mode())) {
          ledger.changeMode('blocked', 'guardian-installation-failed');
        }
        throw new DeliveryError('guardian-installation-failed', true);
      }
      output({ mode: ledger.mode(), digest: digest(mandate) });
    } else if (command === 'scope') {
      const scopeValue: unknown = JSON.parse(
        readFileSync(requiredOption(options, 'scope'), 'utf8'),
      );
      output({
        digest: changeDeliveryScope(ledger, scopeValue, options.authorize),
        mode: ledger.mode(),
      });
    } else if (command === 'reopen') {
      reopenDeliveryIssue(
        ledger,
        numericOption(options, 'issue'),
        numericOption(options, 'active-minutes'),
        numericOption(options, 'repairs'),
        requiredOption(options, 'authorize'),
        {
          ...(options['operation-id'] === undefined
            ? {}
            : { operationId: options['operation-id'] }),
          providerStarts:
            options['provider-starts'] === undefined
              ? 0
              : numericOption(options, 'provider-starts'),
          designRuns:
            options['design-runs'] === undefined ? 0 : numericOption(options, 'design-runs'),
          liveStarts:
            options['live-starts'] === undefined ? 0 : numericOption(options, 'live-starts'),
        },
      );
      output({ issue: numericOption(options, 'issue'), reopened: true });
    } else if (command === 'daemon') {
      verifyFrozenRuntime(ledger.mandate());
      await runDeliveryGuardian(ledger, cancellation.signal);
    } else {
      const controlFile = process.env.AGENT_QUORUM_EXECUTION_CONTROL_FILE;
      if (controlFile === undefined) {
        throw new DeliveryError('internal-command-requires-guardian', true);
      }
      const execution = readExecutionHandoff(controlFile);
      verifyFrozenRuntime(ledger.mandate());
      if (command === 'internal-recovery') {
        if (requiredOption(options, 'digest') !== digest(ledger.mandate())) {
          throw new DeliveryError('shared-main-recovery-digest-mismatch', true);
        }
        await checkSharedMainRecovery(ledger, execution);
      } else if (command === 'internal-step') {
        const result = await runDeliveryStep(ledger, execution);
        ledger.set('next-wait-ms', result.waitMs);
      } else if (command === 'internal-hook') {
        const issue = numericOption(options, 'issue');
        if (path.resolve(process.cwd()) !== ledger.issue(issue)?.worktree) {
          throw new DeliveryError('hook-worktree-mismatch', true);
        }
        const broker = new RepositoryBroker(ledger, ledger.mandate(), execution);
        const result = await broker.verify(process.cwd(), ['run', 'check'], issue);
        if (result.exitCode !== 0) {
          throw new DeliveryError('precommit-verification-failed');
        }
        await broker.git(process.cwd(), ['add', '-u'], issue, true);
      } else if (command === 'internal-probe') {
        await runActivationProbes(
          ledger,
          requiredOption(options, 'digest'),
          execution,
          verifyProviderConfinement,
        );
      }
    }
  } finally {
    process.removeListener('SIGTERM', interrupt);
    process.removeListener('SIGINT', interrupt);
    ledger.close();
  }
}

export async function deliveryMain(args: readonly string[] = process.argv.slice(2)): Promise<void> {
  try {
    await runDeliveryCli(args);
  } catch (error) {
    const code = error instanceof DeliveryError ? error.code : 'delivery-operation-failed';
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  await deliveryMain();
}
