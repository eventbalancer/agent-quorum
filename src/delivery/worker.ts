import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { resolveConfig, type OperatorConfig } from '../core/config.js';
import { resolveWatchdogKnobs } from '../core/knobs.js';
import { providerRun, type ProviderTaskRequest } from '../providers/provider.js';
import { supervisedCodexPolicy } from '../providers/supervised-policy.js';
import { resolveRunnerBinaries } from '../providers/registry.js';
import type { ProviderRuntime } from '../providers/runtime.js';
import type { ExecutionControl } from '../runtime/execution-control.js';
import { Scratch } from '../runtime/scratch.js';
import {
  DeliveryError,
  type AcceptanceCriterion,
  type DeliveryFinding,
  type Mandate,
} from './contract.js';
import type { DeliveryEdit } from './edits.js';
import type { ReviewReceipt } from './evidence.js';

export interface WorkerResult {
  readonly action:
    | 'refined'
    | 'edit'
    | 'ready'
    | 'blocked'
    | 'resolved'
    | 'duplicate'
    | 'decomposed';
  readonly acceptance: readonly AcceptanceCriterion[];
  readonly decisions: readonly string[];
  readonly dependencies: readonly number[];
  readonly findings: readonly DeliveryFinding[];
  readonly requiresPlan: boolean;
  readonly rationale: string;
  readonly relatedIssue: number | null;
  readonly edits: readonly DeliveryEdit[];
  readonly targetedTests: readonly string[];
  readonly packageOperations?: readonly 'refresh-lockfile'[];
  readonly uncertainty: string;
}

export type ReviewerResult = Pick<
  ReviewReceipt,
  | 'approved'
  | 'findings'
  | 'acceptanceEvidence'
  | 'adjacentFindings'
  | 'liveReuseApproved'
  | 'interveningDiffDigest'
>;

export interface WorkerCall {
  readonly issue: number;
  readonly cwd: string;
  readonly prompt: string;
  readonly outputFile: string;
  readonly execution: ExecutionControl;
}

export interface WorkerAnswer<T> {
  readonly invocationId: string;
  readonly result: T;
}

export function readPlanningConfig(mandate: Mandate): OperatorConfig {
  const parsed = JSON.parse(
    readFileSync(mandate.profile.planning.configFile, 'utf8'),
  ) as OperatorConfig;
  resolveConfig({
    home: path.join(mandate.runtimeRoot, '.empty-home'),
    env: {},
    overrides: { config: parsed },
  });
  return parsed;
}

function providerRuntime(
  mandate: Mandate,
  scratch: Scratch,
  cwd: string,
  execution: ExecutionControl,
): ProviderRuntime {
  const config = resolveConfig({
    home: path.join(mandate.runtimeRoot, '.empty-home'),
    env: {},
    overrides: { config: readPlanningConfig(mandate) },
  }).config;
  const bounds = mandate.profile.bounds;
  return {
    scratch,
    projectRoot: cwd,
    retry: {
      retryCount: bounds.providerRetries,
      retryDelaySeconds: bounds.providerRetryDelayMs / 1000,
    },
    streamKnobs: resolveWatchdogKnobs(config).stream,
    matrix: config.matrix,
    sessionMode: 0,
    creatorSessionFile: '',
    markdownSchemaPath: path.join(mandate.runtimeRoot, 'skills/_shared/markdown.schema.json'),
    binaries: resolveRunnerBinaries(),
    livenessHeartbeatSeconds: 0,
    claudeThinkingEvery: 0,
    execution,
  };
}

export class CodexDeliveryWorker {
  constructor(private readonly mandate: Mandate) {}

  private async call<T>(
    role: 'delivery-worker' | 'delivery-reviewer',
    input: WorkerCall,
  ): Promise<WorkerAnswer<T>> {
    const profile =
      role === 'delivery-worker' ? this.mandate.profile.worker : this.mandate.profile.reviewer;
    const schemaFile = path.join(this.mandate.runtimeRoot, 'skills', role, 'output.schema.json');
    const schema: object = JSON.parse(readFileSync(schemaFile, 'utf8')) as object;
    const validate = new Ajv2019({ allErrors: true }).compile<T>(schema);
    const scratch = Scratch.create('delivery-provider');
    const invocationId = randomUUID();
    try {
      const execution: ExecutionControl = {
        ...input.execution,
        deadlineEpochMs: Math.min(
          input.execution.deadlineEpochMs ?? Infinity,
          Date.now() + this.mandate.profile.bounds.providerTimeoutMs,
        ),
      };
      const runtime = providerRuntime(this.mandate, scratch, input.cwd, execution);
      const request: ProviderTaskRequest = {
        task: `${role}-${input.issue}-${invocationId}`,
        runner: 'codex',
        model: profile.model,
        reasoning: profile.reasoning,
        mode: 'json',
        outFile: input.outputFile,
        schemaFile,
        skillFile: path.join(this.mandate.runtimeRoot, 'skills', role, 'SKILL.md'),
        promptText: input.prompt,
        cwd: input.cwd,
        ...supervisedCodexPolicy(
          input.cwd,
          [this.mandate.runtimeRoot, path.dirname(this.mandate.runtimeRoot)],
          this.mandate.mcpServerNames,
        ),
        execution,
        validateOutput: (file) => {
          try {
            const value: unknown = JSON.parse(readFileSync(file, 'utf8'));
            return validate(value);
          } catch {
            return false;
          }
        },
      };
      const exitCode = await providerRun(runtime, request);
      if (exitCode !== 0) {
        throw new DeliveryError('delivery-provider-failed');
      }
      const result: unknown = JSON.parse(readFileSync(input.outputFile, 'utf8'));
      if (!validate(result)) {
        throw new DeliveryError('invalid-delivery-provider-output');
      }
      return { invocationId, result };
    } finally {
      scratch.sweep();
    }
  }

  work(input: WorkerCall): Promise<WorkerAnswer<WorkerResult>> {
    return this.call('delivery-worker', input);
  }

  review(input: WorkerCall): Promise<WorkerAnswer<ReviewerResult>> {
    return this.call('delivery-reviewer', input);
  }
}
