import type { ExecutionControl } from '../runtime/execution-control.js';
import { spawnControlled } from '../runtime/execution-control.js';
import { terminateOwned, waitForExit } from '../runtime/exec.js';
import { supervisedCodexEnvironment } from '../providers/supervised-policy.js';
import { DeliveryError, digest } from './contract.js';

export function canonicalConfiguration(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalConfiguration);
  }
  if (typeof value !== 'object' || value === null) {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, canonicalConfiguration(entry)]),
  );
}

export function codexConfigurationDigest(value: unknown): string {
  if (
    typeof value !== 'object' ||
    value === null ||
    !('config' in value) ||
    typeof value.config !== 'object' ||
    value.config === null ||
    !('layers' in value) ||
    !Array.isArray(value.layers) ||
    value.layers.some(
      (layer: unknown) =>
        typeof layer !== 'object' ||
        layer === null ||
        !('name' in layer) ||
        !('version' in layer) ||
        typeof layer.version !== 'string' ||
        !('config' in layer),
    )
  ) {
    throw new DeliveryError('effective-codex-configuration-unavailable', true);
  }
  return digest(canonicalConfiguration({ config: value.config, layers: value.layers }));
}

export async function readCodexConfigurationDigest(
  cwd: string,
  execution: ExecutionControl,
  config: readonly string[],
  command = {
    bin: 'codex',
    args: [...config.flatMap((entry) => ['-c', entry]), 'app-server', '--stdio'],
  },
): Promise<string> {
  const child = await spawnControlled(
    command.bin,
    command.args,
    { cwd, stdio: ['pipe', 'pipe', 'ignore'] },
    {
      ...execution,
      env: supervisedCodexEnvironment(execution.env ?? process.env),
      deadlineEpochMs: Math.min(execution.deadlineEpochMs ?? Infinity, Date.now() + 3500),
      terminateGraceMs: 0,
    },
  );
  let buffer = '';
  let receivedBytes = 0;
  let userAgent: string | undefined;
  child.stdin?.on('error', () => undefined);
  const completed = waitForExit(child);
  try {
    return await new Promise<string>((resolve, reject) => {
      const fail = () => {
        reject(new DeliveryError('effective-codex-configuration-unavailable', true));
      };
      void completed.then(fail);
      child.stdout?.on('data', (chunk: Buffer) => {
        receivedBytes += chunk.length;
        if (receivedBytes > 8 * 1024 * 1024) {
          fail();
          return;
        }
        buffer += chunk.toString('utf8');
        let newline: number;
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          try {
            const value: unknown = JSON.parse(line);
            if (typeof value !== 'object' || value === null || !('id' in value)) {
              continue;
            }
            if ('error' in value) {
              fail();
              return;
            }
            if (value.id === 1) {
              if (
                !('result' in value) ||
                typeof value.result !== 'object' ||
                value.result === null ||
                !('userAgent' in value.result) ||
                typeof value.result.userAgent !== 'string'
              ) {
                fail();
                return;
              }
              userAgent = value.result.userAgent;
              child.stdin?.write(`${JSON.stringify({ method: 'initialized' })}\n`);
              child.stdin?.write(
                `${JSON.stringify({ id: 2, method: 'config/read', params: { includeLayers: true } })}\n`,
              );
            } else if (value.id === 2 && 'result' in value) {
              if (userAgent === undefined) {
                fail();
                return;
              }
              resolve(digest({ userAgent, configuration: codexConfigurationDigest(value.result) }));
              return;
            }
          } catch {
            fail();
            return;
          }
        }
      });
      child.stdin?.write(
        `${JSON.stringify({ id: 1, method: 'initialize', params: { clientInfo: { name: 'agent-quorum-delivery-attestation', version: '1' }, capabilities: { experimentalApi: true } } })}\n`,
      );
    });
  } finally {
    await terminateOwned(child, 0);
  }
}
