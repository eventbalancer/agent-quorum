import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http, { createServer, type Server } from 'node:http';
import https from 'node:https';
import os, { type NetworkInterfaceInfo } from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { launchPlanLoop, type LaunchPlanLoopOptions } from '../../src/index.js';
import { runCliAsync, type EnvOverrides } from '../helpers/cli.js';
import {
  emptyCritique,
  withEnvAsync,
  writeDefaultPlanLoopConfig,
  writeFakeBin,
  writeStructuredPlanFile,
} from '../helpers/harness.js';

const INSTALL_FLAG = Symbol.for('agent-quorum.test.network-guard.installed');
const GUARD_MARKER = 'agent-quorum network guard';
const COMPLETION_WARNING = 'WARNING: failed to send Telegram completion notification';
const EXECUTABLE_FILE_MODE = 0o755;
const KILL_SETTLE_DELAY_MS = 100;
const LOG_POLL_ATTEMPTS = 60;
const LOG_POLL_INTERVAL_MS = 200;
const PLAN_MODE_TEST_TIMEOUT_MS = 60_000;
const LAUNCH_MODE_TEST_TIMEOUT_MS = 30_000;
const LAUNCH_VERIFY_DELAY_SECONDS = '0.5';
const SLOW_CODEX_SLEEP_SECONDS = '1.5';

const throwingLookup = (): never => {
  throw new Error('the network guard must block before any DNS lookup runs');
};

interface NonLoopbackAddress {
  readonly family: 'IPv4' | 'IPv6';
  readonly address: string;
}

function isUsableIpv4Address(info: NetworkInterfaceInfo): boolean {
  return !info.internal && info.family === 'IPv4';
}

function isUsableIpv6Address(info: NetworkInterfaceInfo): boolean {
  const isLinkLocal = info.address.toLowerCase().startsWith('fe80');
  return !info.internal && info.family === 'IPv6' && !isLinkLocal;
}

function stripIpv6Scope(address: string): string {
  return address.split('%')[0] ?? address;
}

function pickNonLoopbackAddress(): NonLoopbackAddress | undefined {
  const infos = Object.values(os.networkInterfaces()).flatMap((entry) => entry ?? []);
  const ipv4 = infos.find(isUsableIpv4Address);
  if (ipv4 !== undefined) {
    return { family: 'IPv4', address: ipv4.address };
  }
  const ipv6 = infos.find(isUsableIpv6Address);
  if (ipv6 !== undefined) {
    return { family: 'IPv6', address: stripIpv6Scope(ipv6.address) };
  }
  return undefined;
}

interface NumericTarget {
  readonly base: string;
  readonly hasSentinel: boolean;
  readonly requestCount: () => number;
  readonly close: () => Promise<void>;
}

const TEST_NET_FALLBACK: NumericTarget = {
  base: 'http://192.0.2.1/',
  hasSentinel: false,
  requestCount: () => 0,
  close: () => Promise.resolve(),
};

async function startNumericTarget(): Promise<NumericTarget> {
  const picked = pickNonLoopbackAddress();
  if (picked === undefined) {
    return TEST_NET_FALLBACK;
  }
  let count = 0;
  const server = createServer((_req, res) => {
    count += 1;
    res.end('sentinel');
  });
  const bindHost = picked.family === 'IPv6' ? '::' : '0.0.0.0';
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, bindHost, () => {
        resolve();
      });
    });
  } catch {
    return TEST_NET_FALLBACK;
  }
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const host = picked.family === 'IPv6' ? `[${picked.address}]` : picked.address;
  return {
    base: `http://${host}:${port}/`,
    hasSentinel: true,
    requestCount: () => count,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      }),
  };
}

async function startLoopbackServer(host: string): Promise<Server | undefined> {
  try {
    return await new Promise<Server>((resolve, reject) => {
      const server = createServer((_req, res) => {
        res.end('loopback-ok');
      });
      server.once('error', reject);
      server.listen(0, host, () => {
        resolve(server);
      });
    });
  } catch {
    return undefined;
  }
}

function serverPort(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve) => {
    server.close(() => {
      resolve();
    });
  });
}

async function waitForLogContent(
  logPath: string,
  predicate: (text: string) => boolean,
  maxAttempts = LOG_POLL_ATTEMPTS,
  intervalMs = LOG_POLL_INTERVAL_MS,
): Promise<string> {
  let logText = '';
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (logPath !== '' && existsSync(logPath)) {
      logText = readFileSync(logPath, 'utf8');
      if (predicate(logText)) {
        return logText;
      }
    }
    await sleep(intervalMs);
  }
  return logText;
}

function captureRequestError(request: http.ClientRequest): Promise<Error> {
  return new Promise<Error>((resolve, reject) => {
    request.on('error', resolve);
    request.on('response', (response) => {
      response.resume();
      reject(new Error('expected the guard to block the request, but a response arrived'));
    });
    request.end();
  });
}

async function killDetachedRun(pid: number): Promise<void> {
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await sleep(KILL_SETTLE_DELAY_MS);
}

let tmp: string;
let fake: string;
let work: string;
let target: NumericTarget;

// A critic stand-in that emits the empty critique, then outlives the launch
// verify delay before exiting, so the detached run stays alive past the verify
// check yet still converges and fires the completion notification afterward.
function writeSlowCompletingCodex(): void {
  const script = [
    '#!/usr/bin/env bash',
    'if [[ "${1:-}" == "login" && "${2:-}" == "status" ]]; then exit 0; fi',
    'out=""',
    'while [[ $# -gt 0 ]]; do',
    '  case "$1" in',
    '    -o|--output-last-message) out="$2"; shift 2 ;;',
    '    *) shift ;;',
    '  esac',
    'done',
    '[[ -n "$out" ]] || exit 2',
    'cp "${FAKE_CODEX_OUTPUT:?}" "$out"',
    "printf 'tokens used\\n1\\n'",
    `sleep ${SLOW_CODEX_SLEEP_SECONDS}`,
    'exit 0',
  ].join('\n');
  writeFileSync(path.join(fake, 'codex'), `${script}\n`);
  chmodSync(path.join(fake, 'codex'), EXECUTABLE_FILE_MODE);
}

function childEnv(extra: EnvOverrides = {}): EnvOverrides {
  return {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    AGENT_QUORUM_CONFIG_FILE: path.join(tmp, 'agent-quorum.json'),
    AGENT_QUORUM_PLANS_DIR: path.join(tmp, 'plans'),
    AGENT_QUORUM_STATE_DIR: path.join(tmp, 'state'),
    AGENT_QUORUM_CLARIFY: '0',
    AGENT_QUORUM_RETRY_COUNT: '0',
    FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
    FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
    AGENT_QUORUM_TELEGRAM_BOT_TOKEN: 't',
    AGENT_QUORUM_TELEGRAM_CHAT_ID: '42',
    AGENT_QUORUM_TELEGRAM_API_BASE: target.base,
    ...extra,
  };
}

beforeAll(async () => {
  target = await startNumericTarget();
});

afterAll(async () => {
  await target.close();
});

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-guardtest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'), { recursive: true });
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  writeDefaultPlanLoopConfig(path.join(tmp, 'agent-quorum.json'));
  writeStructuredPlanFile(path.join(tmp, 'input.md'), 'Guard Input');
  emptyCritique(path.join(tmp, 'empty.json'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('network guard regression self-test', () => {
  it('is installed in this worker', () => {
    expect(Reflect.get(globalThis, INSTALL_FLAG)).toBe(true);
  });

  it('blocks an in-process fetch to a numeric non-loopback address', async () => {
    const before = target.requestCount();
    await expect(fetch(`${target.base}x`)).rejects.toThrow(GUARD_MARKER);
    if (target.hasSentinel) {
      expect(target.requestCount()).toBe(before);
    }
  });

  it('blocks raw http and https through the socket and tls catch-all', async () => {
    const httpError = await captureRequestError(
      http.request('http://blocked.invalid/', { lookup: throwingLookup }),
    );
    expect(httpError.message).toMatch(GUARD_MARKER);
    const httpsError = await captureRequestError(
      https.request('https://blocked.invalid/', { lookup: throwingLookup }),
    );
    expect(httpsError.message).toMatch(GUARD_MARKER);
  });

  it('treats 127-prefixed hostnames as remote, not loopback', async () => {
    for (const host of ['127.example.test', '127.0.0.1.example.com']) {
      const error = await captureRequestError(
        http.request(`http://${host}/`, { lookup: throwingLookup }),
      );
      expect(error.message, host).toMatch(GUARD_MARKER);
    }
  });

  it('allows loopback servers through the guard', async () => {
    const ipv4Server = await startLoopbackServer('127.0.0.1');
    expect(ipv4Server).toBeDefined();
    if (ipv4Server !== undefined) {
      try {
        const response = await fetch(`http://127.0.0.1:${serverPort(ipv4Server)}/`);
        expect(response.status).toBe(200);
        expect(await response.text()).toBe('loopback-ok');
      } finally {
        await closeServer(ipv4Server);
      }
    }

    const ipv6Server = await startLoopbackServer('::1');
    if (ipv6Server !== undefined) {
      try {
        const response = await fetch(`http://[::1]:${serverPort(ipv6Server)}/`);
        expect(response.status).toBe(200);
      } finally {
        await closeServer(ipv6Server);
      }
    }
  });

  it(
    'blocks the plan-mode subprocess completion send via inherited NODE_OPTIONS',
    async () => {
      const before = target.requestCount();
      const planCliArgs = [
        'plan',
        '--effort',
        'low',
        '--iters',
        '1',
        path.join(tmp, 'input.md'),
        '--no-fix',
        '--no-translate',
      ] as const;
      const planCliEnv = childEnv({ AGENT_QUORUM_WORK_DIR: work });
      const result = await runCliAsync(planCliArgs, planCliEnv);
      expect(result.status).toBe(0);
      expect(result.stderr).toMatch(GUARD_MARKER);
      expect(result.stderr).toContain(COMPLETION_WARNING);
      if (target.hasSentinel) {
        expect(target.requestCount()).toBe(before);
      }
    },
    PLAN_MODE_TEST_TIMEOUT_MS,
  );

  it(
    'blocks the launch-mode detached grandchild completion send',
    async () => {
      writeSlowCompletingCodex();
      const before = target.requestCount();
      const launchEnv = childEnv({
        AGENT_QUORUM_LAUNCH_VERIFY_DELAY: LAUNCH_VERIFY_DELAY_SECONDS,
      });
      const launchOptions = {
        input: path.join(tmp, 'input.md'),
        iters: 1,
        effort: 'low',
        fix: false,
        translate: false,
      } satisfies LaunchPlanLoopOptions;
      const launch = await withEnvAsync(launchEnv, () => {
        return launchPlanLoop(launchOptions);
      });
      expect(launch.exitCode).toBe(0);
      const logPath = launch.logPath ?? '';
      const pid = launch.pid ?? 0;
      try {
        const logText = await waitForLogContent(
          logPath,
          (text) => text.includes(GUARD_MARKER) && text.includes(COMPLETION_WARNING),
        );
        expect(logText).toMatch(GUARD_MARKER);
        expect(logText).toContain(COMPLETION_WARNING);
        if (target.hasSentinel) {
          expect(target.requestCount()).toBe(before);
        }
      } finally {
        if (pid > 0) {
          await killDetachedRun(pid);
        }
      }
    },
    LAUNCH_MODE_TEST_TIMEOUT_MS,
  );
});
