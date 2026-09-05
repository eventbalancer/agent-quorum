import { createHash } from 'node:crypto';
import { Ajv2019 } from 'ajv/dist/2019.js';
import type { Quality } from '../types.js';

export const DELIVERY_REPOSITORY = 'eventbalancer/agent-quorum';
export const ISSUE_LIMIT_MS = 120 * 60_000;
export const DAY_LIMIT_MS = 360 * 60_000;
export const REPAIR_LIMIT = 2;
export const POLICY_VERSION = 1;
export const DELIVERY_OPERATIONS = [
  'edit',
  'verify',
  'plan',
  'review',
  'branch',
  'commit',
  'push',
  'pull-request',
  'merge',
  'issue',
  'project',
] as const;
export type DeliveryOperation = (typeof DELIVERY_OPERATIONS)[number];
export type DeliveryMode =
  | 'prepared'
  | 'blocked'
  | 'active'
  | 'pausing'
  | 'paused'
  | 'stopped'
  | 'revoked'
  | 'daily-limit';
export type IssueStage =
  | 'refine'
  | 'plan'
  | 'implement'
  | 'verify'
  | 'review'
  | 'commit'
  | 'live'
  | 'pull-request'
  | 'ci'
  | 'merge'
  | 'main-ci'
  | 'reconcile'
  | 'recover'
  | 'done'
  | 'deferred';
export type FindingKind = 'necessary' | 'adjacent' | 'prerequisite' | 'observation';

export interface DeliveryScope {
  readonly include: readonly number[];
  readonly exclude: readonly number[];
  readonly priorities: readonly number[];
}

export interface ModelProfile {
  readonly model: string;
  readonly reasoning: string;
}

export interface DeliveryBounds {
  readonly providerStartsPerIssue: number;
  readonly providerStartsPerDay: number;
  readonly providerTimeoutMs: number;
  readonly providerRetries: number;
  readonly providerRetryDelayMs: number;
  readonly commandTimeoutMs: number;
  readonly liveStartsPerScenario: number;
  readonly liveScenarioTimeoutMs: number;
}

interface DeliveryPlanningProfile {
  readonly configFile: string;
  readonly quality: Quality;
  readonly maxIterations: number;
  readonly maxRuns: number;
}

interface DeliveryExecutorProfile {
  readonly kind: 'docker';
  readonly image: string;
}

interface DeliveryProjectProfile {
  readonly id: string;
  readonly statusFieldId: string;
  readonly inProgressOptionId: string;
  readonly doneOptionId: string;
  readonly blockedOptionId: string;
}

export interface DeliveryProfile {
  readonly worker: ModelProfile;
  readonly reviewer: ModelProfile;
  readonly planning: DeliveryPlanningProfile;
  readonly bounds: DeliveryBounds;
  readonly scope: DeliveryScope;
  readonly executor?: DeliveryExecutorProfile;
  readonly project?: DeliveryProjectProfile;
}

export interface CheckIdentity {
  readonly context: string;
  readonly appId: number;
}

export interface Mandate {
  readonly version: 1;
  readonly repository: typeof DELIVERY_REPOSITORY;
  readonly base: 'main';
  readonly sourceRoot: string;
  readonly runtimeRoot: string;
  readonly controllerDigest: string;
  readonly profileDigest: string;
  readonly policyVersion: typeof POLICY_VERSION;
  readonly profile: DeliveryProfile;
  readonly requiredChecks: readonly CheckIdentity[];
  readonly actor: string;
  readonly mcpServerNames: readonly string[];
  readonly mcpConfigurationDigest: string;
  readonly workflowTreeSha: string;
  readonly issueLimitMs: typeof ISSUE_LIMIT_MS;
  readonly dailyLimitMs: typeof DAY_LIMIT_MS;
  readonly repairLimit: typeof REPAIR_LIMIT;
  readonly timezone: 'Europe/Moscow';
  readonly operations: readonly DeliveryOperation[];
  readonly releases: false;
  readonly createdAt: string;
}

export interface DeliveryFinding {
  readonly kind: FindingKind;
  readonly title: string;
  readonly problem: string;
  readonly evidence: readonly string[];
  readonly outcome: string;
  readonly uncertainty: string;
  readonly relatedIssue: number | null;
}

export interface AcceptanceCriterion {
  readonly id: string;
  readonly outcome: string;
  readonly evidence: readonly string[];
}

export interface DeliveryIssue {
  readonly number: number;
  readonly nodeId: string;
  readonly title: string;
  readonly originalBody: string;
  readonly originalTitle?: string;
  readonly currentBody?: string;
  readonly fingerprint: string;
  readonly stage: IssueStage;
  readonly baseSha: string;
  readonly acceptance: readonly AcceptanceCriterion[];
  readonly decisions: readonly string[];
  readonly dependencies: readonly number[];
  readonly findingKeys: readonly string[];
  readonly worktree?: string;
  readonly branch?: string;
  readonly candidateSha?: string;
  readonly pullRequest?: number;
  readonly mergedSha?: string;
  readonly designWorkDir?: string;
  readonly blocker?: string;
  readonly reconsiderWhen?: string;
  readonly receipt?: string;
  readonly feedback?: string;
}

export class DeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly isShared = false,
  ) {
    super(code);
    this.name = 'DeliveryError';
  }
}

const positiveInteger = { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER };
const nonnegativeInteger = { ...positiveInteger, minimum: 0 };
const text = { type: 'string', minLength: 1 };
const issueNumbers = { type: 'array', items: positiveInteger, uniqueItems: true };
const modelSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['model', 'reasoning'],
  properties: { model: text, reasoning: text },
};
const boundsSchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'providerStartsPerIssue',
    'providerStartsPerDay',
    'providerTimeoutMs',
    'providerRetries',
    'providerRetryDelayMs',
    'commandTimeoutMs',
    'liveStartsPerScenario',
    'liveScenarioTimeoutMs',
  ],
  properties: {
    providerStartsPerIssue: positiveInteger,
    providerStartsPerDay: positiveInteger,
    providerTimeoutMs: { ...positiveInteger, maximum: ISSUE_LIMIT_MS },
    providerRetries: nonnegativeInteger,
    providerRetryDelayMs: { ...nonnegativeInteger, maximum: ISSUE_LIMIT_MS },
    commandTimeoutMs: { ...positiveInteger, maximum: ISSUE_LIMIT_MS },
    liveStartsPerScenario: positiveInteger,
    liveScenarioTimeoutMs: { ...positiveInteger, maximum: ISSUE_LIMIT_MS },
  },
};
export const DELIVERY_PROFILE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['worker', 'reviewer', 'planning', 'bounds', 'scope'],
  properties: {
    worker: modelSchema,
    reviewer: modelSchema,
    bounds: boundsSchema,
    executor: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'image'],
      properties: {
        kind: { const: 'docker' },
        image: { type: 'string', pattern: '^[a-zA-Z0-9][a-zA-Z0-9._/:~-]*@sha256:[a-f0-9]{64}$' },
      },
    },
    scope: {
      type: 'object',
      additionalProperties: false,
      required: ['include', 'exclude', 'priorities'],
      properties: { include: issueNumbers, exclude: issueNumbers, priorities: issueNumbers },
    },
    planning: {
      type: 'object',
      additionalProperties: false,
      required: ['configFile', 'quality', 'maxIterations', 'maxRuns'],
      properties: {
        configFile: text,
        quality: { enum: ['quick', 'balanced', 'thorough'] },
        maxIterations: positiveInteger,
        maxRuns: positiveInteger,
      },
    },
    project: {
      type: 'object',
      additionalProperties: false,
      required: ['id', 'statusFieldId', 'inProgressOptionId', 'doneOptionId', 'blockedOptionId'],
      properties: {
        id: text,
        statusFieldId: text,
        inProgressOptionId: text,
        doneOptionId: text,
        blockedOptionId: text,
      },
    },
  },
};
const profileValidator = new Ajv2019({ allErrors: true }).compile<DeliveryProfile>(
  DELIVERY_PROFILE_SCHEMA,
);

export function parseDeliveryProfile(value: unknown): DeliveryProfile {
  if (!profileValidator(value)) {
    throw new DeliveryError('invalid-delivery-profile', true);
  }
  if (value.bounds.providerStartsPerDay < value.bounds.providerStartsPerIssue) {
    throw new DeliveryError('provider-day-limit-below-issue-limit', true);
  }
  if (value.bounds.providerRetries >= value.bounds.providerStartsPerIssue) {
    throw new DeliveryError('provider-retries-exceed-issue-starts', true);
  }
  if (value.bounds.liveScenarioTimeoutMs * 2 > ISSUE_LIMIT_MS) {
    throw new DeliveryError('mandatory-live-gate-exceeds-issue-allowance', true);
  }
  return value;
}

const mandateValidator = new Ajv2019({ allErrors: true }).compile<Mandate>({
  type: 'object',
  additionalProperties: false,
  required: [
    'version',
    'repository',
    'base',
    'sourceRoot',
    'runtimeRoot',
    'controllerDigest',
    'profileDigest',
    'policyVersion',
    'profile',
    'requiredChecks',
    'actor',
    'mcpServerNames',
    'mcpConfigurationDigest',
    'workflowTreeSha',
    'issueLimitMs',
    'dailyLimitMs',
    'repairLimit',
    'timezone',
    'operations',
    'releases',
    'createdAt',
  ],
  properties: {
    version: { const: 1 },
    repository: { const: DELIVERY_REPOSITORY },
    base: { const: 'main' },
    sourceRoot: text,
    runtimeRoot: text,
    controllerDigest: text,
    profileDigest: text,
    policyVersion: { const: POLICY_VERSION },
    profile: DELIVERY_PROFILE_SCHEMA,
    requiredChecks: {
      type: 'array',
      uniqueItems: true,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['context', 'appId'],
        properties: { context: text, appId: positiveInteger },
      },
    },
    actor: text,
    mcpServerNames: { type: 'array', uniqueItems: true, items: text },
    mcpConfigurationDigest: text,
    workflowTreeSha: text,
    issueLimitMs: { const: ISSUE_LIMIT_MS },
    dailyLimitMs: { const: DAY_LIMIT_MS },
    repairLimit: { const: REPAIR_LIMIT },
    timezone: { const: 'Europe/Moscow' },
    operations: {
      type: 'array',
      minItems: 1,
      uniqueItems: true,
      items: { enum: DELIVERY_OPERATIONS },
    },
    releases: { const: false },
    createdAt: text,
  },
});

export function parseMandate(value: unknown): Mandate {
  if (!mandateValidator(value)) {
    throw new DeliveryError('incompatible-mandate-policy', true);
  }
  parseDeliveryProfile(value.profile);
  return value;
}

export function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function contentDigest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function scopeIncludes(scope: DeliveryScope, issue: number): boolean {
  return (
    !scope.exclude.includes(issue) && (scope.include.length === 0 || scope.include.includes(issue))
  );
}

export function scopeExpands(previous: DeliveryScope, next: DeliveryScope): boolean {
  if (previous.include.length > 0 && next.include.length === 0) {
    return true;
  }
  if (next.include.some((issue) => !scopeIncludes(previous, issue) && scopeIncludes(next, issue))) {
    return true;
  }
  return previous.exclude.some((issue) => scopeIncludes(next, issue));
}
