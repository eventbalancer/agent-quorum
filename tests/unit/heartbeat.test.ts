import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnDetached } from '../../src/runtime/exec.js';
import { HaltError } from '../../src/runtime/halt.js';
import { livenessHeartbeatSeconds, runLivenessHeartbeat } from '../../src/providers/heartbeat.js';
import type { TraceContext } from '../../src/providers/trace.js';
import { captureStderr, withEnv, type StderrCapture } from '../helpers/harness.js';

const ENV = 'AGENT_QUORUM_LIVENESS_HEARTBEAT_SECONDS';
const CONTEXT: TraceContext = { role: 'critic', provider: 'codex', model: 'gpt-5.5' };

describe('livenessHeartbeatSeconds', () => {
  it('defaults to 30 when unset or empty', () => {
    expect(withEnv({ [ENV]: undefined }, () => livenessHeartbeatSeconds())).toBe(30);
    expect(withEnv({ [ENV]: '' }, () => livenessHeartbeatSeconds())).toBe(30);
  });

  it('parses a positive cadence and the 0 disable sentinel', () => {
    expect(withEnv({ [ENV]: '2' }, () => livenessHeartbeatSeconds())).toBe(2);
    expect(withEnv({ [ENV]: '0' }, () => livenessHeartbeatSeconds())).toBe(0);
  });

  it('halts on a non-integer value', () => {
    expect(() => withEnv({ [ENV]: 'abc' }, () => livenessHeartbeatSeconds())).toThrow(HaltError);
  });
});

describe('runLivenessHeartbeat', () => {
  let capture: StderrCapture;

  beforeEach(() => {
    capture = captureStderr();
  });

  afterEach(() => {
    capture.restore();
  });

  it('emits at least one liveness line while a child outlives the cadence', async () => {
    const child = spawnDetached('sh', ['-c', 'sleep 3'], { stdio: 'ignore' });
    await runLivenessHeartbeat(child, CONTEXT, 1);
    expect(capture.text()).toContain('still working');
    expect(capture.text()).toContain('critic/codex');
  }, 30_000);

  it('emits nothing when disabled with seconds=0', async () => {
    const child = spawnDetached('sh', ['-c', 'sleep 0.1'], { stdio: 'ignore' });
    await runLivenessHeartbeat(child, CONTEXT, 0);
    expect(capture.text()).not.toContain('still working');
  });

  it('emits nothing when the child exits before the first interval', async () => {
    const child = spawnDetached('sh', ['-c', 'sleep 0.2'], { stdio: 'ignore' });
    await runLivenessHeartbeat(child, CONTEXT, 1);
    expect(capture.text()).not.toContain('still working');
  }, 30_000);

  it('resolves promptly with no line when the binary fails to spawn', async () => {
    const child = spawnDetached('agent-quorum-no-such-binary', [], { stdio: 'ignore' });
    await runLivenessHeartbeat(child, CONTEXT, 1);
    expect(capture.text()).not.toContain('still working');
  }, 30_000);
});
