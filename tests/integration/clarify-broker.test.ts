import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openClarifyBroker } from '../../src/stages/plan/clarify-broker.js';
import type { TelegramRuntime } from '../../src/channels/telegram/index.js';
import { withEnvAsync } from '../helpers/harness.js';

let tmp: string;
let stateDir: string;
let getUpdatesCalls: number;
let getUpdatesHandler: () => Promise<Response>;

const LEASE_SETTLE_MS = 50;

function brokerEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    AGENT_QUORUM_TELEGRAM_BOT_TOKEN: 't',
    AGENT_QUORUM_TELEGRAM_CHAT_ID: '42',
    AGENT_QUORUM_TELEGRAM_STATE_DIR: stateDir,
    AGENT_QUORUM_TELEGRAM_POLL_TIMEOUT: '1',
    AGENT_QUORUM_TELEGRAM_HTTP_TIMEOUT: '1',
    AGENT_QUORUM_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS: '2',
    AGENT_QUORUM_TELEGRAM_RECEIVE_BACKOFF_SECONDS: '1',
    ...extra,
  };
}

function brokerRuntime(): TelegramRuntime {
  return {
    botToken: 't',
    chatId: '42',
    apiBase: 'http://127.0.0.1:1',
    stateDir,
    pollTimeoutSeconds: 1,
    httpTimeoutSeconds: 1,
    receiveFailureWindowSeconds: 2,
    receiveBackoffSeconds: 1,
  };
}

function sharedDir(): string {
  const hash = createHash('sha256').update('t\x0042').digest('hex');
  return path.join(stateDir, 'agent-quorum', 'telegram', hash);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

function emptyUpdates(): Response {
  return jsonResponse({ ok: true, result: [] });
}

function chatUpdates(ids: number[]): Response {
  return jsonResponse({
    ok: true,
    result: ids.map((id) => ({ update_id: id, message: { chat: { id: 42 }, text: `m${id}` } })),
  });
}

interface Deferred {
  readonly promise: Promise<Response>;
  readonly resolve: (value: Response) => void;
}

function deferred(): Deferred {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function waitForLeaseContention(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, LEASE_SETTLE_MS);
  });
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-brokertest.'));
  stateDir = path.join(tmp, 'state');
  getUpdatesCalls = 0;
  getUpdatesHandler = () => Promise.resolve(emptyUpdates());
  vi.spyOn(globalThis, 'fetch').mockImplementation((input: unknown) => {
    const url = String(input);
    if (url.includes('/getUpdates')) {
      getUpdatesCalls += 1;
      return getUpdatesHandler();
    }
    return Promise.resolve(jsonResponse({ ok: true, result: { message_id: 1 } }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(tmp, { recursive: true, force: true });
});

describe('clarify broker', () => {
  it('serializes polling: the lease holder polls and a peer is told peer-held without polling', async () => {
    await withEnvAsync(brokerEnv(), async () => {
      const holder = openClarifyBroker(brokerRuntime());
      const peer = openClarifyBroker(brokerRuntime());
      const gate = deferred();
      getUpdatesHandler = () => gate.promise;

      const holderPoll = holder.tryPoll(1);
      await waitForLeaseContention();

      for (let i = 0; i < 5; i += 1) {
        expect(await peer.tryPoll(1)).toEqual({ peerHeld: true });
      }
      expect(getUpdatesCalls).toBe(1);

      gate.resolve(emptyUpdates());
      expect(await holderPoll).toEqual({ polled: true });

      holder.close();
      peer.close();
    });
  });

  it('steals a stale lock and an outgoing holder does not delete a successor lease', async () => {
    await withEnvAsync(brokerEnv(), async () => {
      const lockFile = path.join(sharedDir(), 'poll.lock');
      const holder = openClarifyBroker(brokerRuntime());
      writeFileSync(lockFile, JSON.stringify({ pid: 1, ts: 1, token: 'ancient' }));

      const gate = deferred();
      getUpdatesHandler = () => gate.promise;
      const holderPoll = holder.tryPoll(1);
      await waitForLeaseContention();

      const afterSteal = JSON.parse(readFileSync(lockFile, 'utf8')) as { token: string };
      expect(afterSteal.token).not.toBe('ancient');
      expect(getUpdatesCalls).toBe(1);

      writeFileSync(lockFile, JSON.stringify({ pid: 2, ts: Date.now(), token: 'successor' }));
      gate.resolve(emptyUpdates());
      expect(await holderPoll).toEqual({ polled: true });

      const surviving = JSON.parse(readFileSync(lockFile, 'utf8')) as { token: string };
      expect(surviving.token).toBe('successor');

      holder.close();
    });
  });

  it('counts a session blocked inside a long poll as live', async () => {
    await withEnvAsync(brokerEnv(), async () => {
      const holder = openClarifyBroker(brokerRuntime());
      const peer = openClarifyBroker(brokerRuntime());
      holder.refresh(5);
      const gate = deferred();
      getUpdatesHandler = () => gate.promise;

      const holderPoll = holder.tryPoll(1);
      await waitForLeaseContention();

      expect(peer.liveSessionCount()).toBe(2);

      gate.resolve(emptyUpdates());
      await holderPoll;
      holder.close();
      peer.close();
    });
  });

  it('compacts the journal below the minimum live-session cursor', async () => {
    await withEnvAsync(brokerEnv(), async () => {
      const holder = openClarifyBroker(brokerRuntime());
      const peer = openClarifyBroker(brokerRuntime());

      getUpdatesHandler = () => Promise.resolve(chatUpdates([1, 2, 3]));
      expect(await holder.tryPoll(1)).toEqual({ polled: true });
      expect(holder.readJournalSince(0).map((entry) => entry.updateId)).toEqual([1, 2, 3]);

      holder.refresh(3);
      peer.refresh(2);
      getUpdatesHandler = () => Promise.resolve(emptyUpdates());
      expect(await holder.tryPoll(1)).toEqual({ polled: true });

      expect(holder.readJournalSince(0).map((entry) => entry.updateId)).toEqual([2, 3]);

      holder.close();
      peer.close();
    });
  });

  it('claims an untargeted update exactly once across handles', async () => {
    await withEnvAsync(brokerEnv(), () => {
      const a = openClarifyBroker(brokerRuntime());
      const b = openClarifyBroker(brokerRuntime());
      expect(a.claimUntargeted(99)).toBe(true);
      expect(b.claimUntargeted(99)).toBe(false);
      a.close();
      b.close();
    });
  });

  it('records a classified failure and surfaces it through health', async () => {
    await withEnvAsync(brokerEnv(), async () => {
      const broker = openClarifyBroker(brokerRuntime());
      getUpdatesHandler = () =>
        Promise.resolve(jsonResponse({ ok: false, error_code: 409, description: 'Conflict' }));
      const result = await broker.tryPoll(1);
      expect('failure' in result && result.failure.kind).toBe('conflict');
      expect(broker.readHealth().failing).toBe(true);
      broker.close();
    });
  });

  it('creates the shared dir 0700 with 0600 files and removes it on last close', async () => {
    await withEnvAsync(brokerEnv(), async () => {
      const a = openClarifyBroker(brokerRuntime());
      const b = openClarifyBroker(brokerRuntime());
      getUpdatesHandler = () => Promise.resolve(chatUpdates([1]));
      await a.tryPoll(1);

      const dir = sharedDir();
      expect(statSync(dir).mode & 0o777).toBe(0o700);
      expect(statSync(path.join(dir, 'updates.jsonl')).mode & 0o777).toBe(0o600);
      expect(statSync(path.join(dir, 'offset')).mode & 0o777).toBe(0o600);

      a.close();
      expect(existsSync(dir)).toBe(true);
      b.close();
      expect(existsSync(dir)).toBe(false);
    });
  });

  it('recovers when a peer tears down the shared dir mid-flight', async () => {
    await withEnvAsync(brokerEnv(), async () => {
      const broker = openClarifyBroker(brokerRuntime());
      rmSync(sharedDir(), { recursive: true, force: true });
      getUpdatesHandler = () => Promise.resolve(emptyUpdates());
      expect(await broker.tryPoll(1)).toEqual({ polled: true });
      expect(existsSync(sharedDir())).toBe(true);
      broker.close();
    });
  });
});
