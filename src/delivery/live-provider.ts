import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { Ajv2019 } from 'ajv/dist/2019.js';
import { resolveConfig, type OperatorConfig } from '../core/config.js';
import { resolveWatchdogKnobs } from '../core/knobs.js';
import type { Quality } from '../types.js';
import type { ProviderRuntime } from '../providers/runtime.js';
import { providerRun, type ProviderTaskRequest } from '../providers/provider.js';
import { resolveRunnerBinaries } from '../providers/registry.js';
import { supervisedCodexPolicy } from '../providers/supervised-policy.js';
import { assertExecutionAllowed, type ExecutionControl } from '../runtime/execution-control.js';
import { Scratch } from '../runtime/scratch.js';
import { DeliveryError, type Mandate } from './contract.js';
import type { LiveProviderJournal } from './live-provenance.js';
import type { CodexProxyCall } from './codex-shim.js';
import { PROVIDER_MESSAGE_BYTES, type ProviderRequestHandler } from './provider-channel.js';

function proxyCall(value: unknown): CodexProxyCall {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(',') !== 'model,prompt,reasoning,schema' ||
    !('model' in value) ||
    typeof value.model !== 'string' ||
    value.model.length > 200 ||
    !('reasoning' in value) ||
    typeof value.reasoning !== 'string' ||
    !('prompt' in value) ||
    typeof value.prompt !== 'string' ||
    Buffer.byteLength(value.prompt) > PROVIDER_MESSAGE_BYTES / 2 ||
    !('schema' in value) ||
    typeof value.schema !== 'object' ||
    value.schema === null ||
    Array.isArray(value.schema) ||
    Buffer.byteLength(JSON.stringify(value.schema)) > PROVIDER_MESSAGE_BYTES / 2
  ) {
    throw new DeliveryError('invalid-confined-provider-request');
  }
  return value as CodexProxyCall;
}

export function createLiveProviderBroker(
  mandate: Mandate,
  execution: ExecutionControl,
  providerConfigText: string,
  repositoryRoot: string,
  quality: Quality,
  invoke: (runtime: ProviderRuntime, request: ProviderTaskRequest) => Promise<number> = providerRun,
  journal?: LiveProviderJournal,
): ProviderRequestHandler {
  const config = resolveConfig({
    home: path.join(mandate.runtimeRoot, '.empty-home'),
    env: {},
    overrides: { config: JSON.parse(providerConfigText) as OperatorConfig, cli: { quality } },
  }).config;
  const entries = Object.values(config.matrix);
  if (entries.some((entry) => entry.runner !== 'codex')) {
    throw new DeliveryError('confined-live-provider-unsupported', true);
  }
  const allowed = new Set(
    entries.map((entry) =>
      JSON.stringify([entry.model, entry.reasoning === 'max' ? 'xhigh' : entry.reasoning]),
    ),
  );
  let queued: Promise<unknown> = Promise.resolve();
  return async (value, signal) => {
    const request = proxyCall(value);
    if (!allowed.has(JSON.stringify([request.model, request.reasoning]))) {
      throw new DeliveryError('confined-provider-profile-mismatch');
    }
    const operation = queued
      .catch(() => undefined)
      .then(async () => {
        const callId = journal?.request(request);
        if (callId !== undefined) {
          const role = journal?.role(callId);
          if (role === undefined || role === 'unknown') {
            throw new DeliveryError('unclassified-live-provider-contract');
          }
          const profile = config.matrix[role];
          const reasoning = profile.reasoning === 'max' ? 'xhigh' : profile.reasoning;
          if (profile.model !== request.model || reasoning !== request.reasoning) {
            throw new DeliveryError('live-provider-role-profile-mismatch');
          }
        }
        const controlled: ExecutionControl = {
          ...execution,
          signal: AbortSignal.any(
            execution.signal === undefined ? [signal] : [signal, execution.signal],
          ),
          attemptTimeoutMs: mandate.profile.bounds.providerTimeoutMs,
          onSpawn: async (process) => {
            if (callId !== undefined) {
              journal?.started(callId, process);
            }
            await execution.onSpawn?.(process);
          },
        };
        assertExecutionAllowed(controlled);
        const scratch = Scratch.create('delivery-live-provider');
        try {
          const schemaFile = scratch.file();
          const outFile = scratch.file();
          const skillFile = scratch.file();
          writeFileSync(schemaFile, JSON.stringify(request.schema));
          writeFileSync(skillFile, '');
          const validate = new Ajv2019({ allErrors: true, strict: false }).compile(
            request.schema as object,
          );
          const status = await invoke(
            {
              scratch,
              projectRoot: repositoryRoot,
              retry: { retryCount: 0, retryDelaySeconds: 0 },
              streamKnobs: resolveWatchdogKnobs(config).stream,
              matrix: config.matrix,
              sessionMode: 0,
              creatorSessionFile: '',
              markdownSchemaPath: schemaFile,
              binaries: resolveRunnerBinaries(),
              livenessHeartbeatSeconds: 0,
              claudeThinkingEvery: 0,
              execution: controlled,
            },
            {
              task: 'delivery-live-smoke',
              runner: 'codex',
              model: request.model,
              reasoning: request.reasoning,
              mode: 'json',
              outFile,
              skillFile,
              schemaFile,
              promptText: request.prompt,
              cwd: repositoryRoot,
              ...supervisedCodexPolicy(
                repositoryRoot,
                [mandate.runtimeRoot, path.dirname(mandate.runtimeRoot)],
                mandate.mcpServerNames,
              ),
              execution: controlled,
              validateOutput: (file) => {
                try {
                  return validate(JSON.parse(readFileSync(file, 'utf8')) as unknown);
                } catch {
                  return false;
                }
              },
            },
          );
          const output = status === 0 ? readFileSync(outFile, 'utf8') : '';
          if (Buffer.byteLength(output) > PROVIDER_MESSAGE_BYTES / 2) {
            throw new DeliveryError('confined-provider-output-limit');
          }
          if (callId !== undefined) {
            journal?.completed(callId, status, output);
          }
          return { status, output };
        } finally {
          scratch.sweep();
        }
      });
    queued = operation;
    return operation;
  };
}
