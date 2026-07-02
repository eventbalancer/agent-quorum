import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import {
  openWorkspaceOrHelp,
  runWebWorkspace,
  shouldStartWorkspace,
  type WorkspaceStreams,
} from '../../src/cli/web/index.js';
import { startWebServer } from '../../src/cli/web/server.js';

interface CollectedOutput {
  readonly stream: { write(text: string): boolean; isTTY?: boolean };
  text(): string;
}

function collectOutput(): CollectedOutput {
  const chunks: string[] = [];
  return {
    stream: {
      isTTY: true,
      write(text: string): boolean {
        chunks.push(text);
        return true;
      },
    },
    text: () => chunks.join(''),
  };
}

const STOP_LINE = '  stop:  Ctrl-C stops the local server\n';

function printedWorkspaceUrl(outputText: string): string {
  const workspaceUrlMatch = /^workspace: (http:\/\/127\.0\.0\.1:\d+\/)$/m.exec(outputText);
  const url = workspaceUrlMatch?.[1];
  if (url === undefined) {
    throw new Error('workspace url not printed');
  }
  return url;
}

describe('openWorkspaceOrHelp seam', () => {
  it('routes an empty dual-TTY to runWorkspace and a non-TTY to writeHelp', async () => {
    const runSpy = vi.fn(() => Promise.resolve(7));
    const helpSpy = vi.fn();
    const tty: WorkspaceStreams = {
      input: { isTTY: true },
      output: { isTTY: true, write: () => true },
    };
    expect(await openWorkspaceOrHelp(tty, { runWorkspace: runSpy, writeHelp: helpSpy })).toBe(7);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(helpSpy).not.toHaveBeenCalled();

    runSpy.mockClear();
    helpSpy.mockClear();
    const nonTty: WorkspaceStreams = {
      input: { isTTY: false },
      output: { isTTY: false, write: () => true },
    };
    expect(await openWorkspaceOrHelp(nonTty, { runWorkspace: runSpy, writeHelp: helpSpy })).toBe(0);
    expect(helpSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('shouldStartWorkspace is true only for empty args in a dual-TTY', () => {
    expect(shouldStartWorkspace([], { isTTY: true }, { isTTY: true })).toBe(true);
    expect(shouldStartWorkspace([], { isTTY: false }, { isTTY: true })).toBe(false);
    expect(shouldStartWorkspace([], { isTTY: true }, { isTTY: false })).toBe(false);
    expect(shouldStartWorkspace(['status'], { isTTY: true }, { isTTY: true })).toBe(false);
  });
});

describe('runWebWorkspace lifecycle', () => {
  it('serves the chat workspace until the first stop signal frees the port', async () => {
    const output = collectOutput();
    const input = { isTTY: true };
    const openBrowser = vi.fn(() => Promise.resolve(true));
    const signals = new EventEmitter();
    const running = runWebWorkspace(
      { input, output: output.stream },
      {
        startServer: () => startWebServer({ preferredPort: 0 }),
        openBrowser,
        signals,
      },
    );
    await vi.waitFor(() => {
      expect(output.text()).toContain(STOP_LINE);
    });
    const url = printedWorkspaceUrl(output.text());
    expect(openBrowser).toHaveBeenCalledTimes(1);
    expect(openBrowser).toHaveBeenCalledWith(url);
    expect(output.text()).not.toContain('  open:');

    const pageResponse = await fetch(url);
    expect(pageResponse.status).toBe(200);
    expect(await pageResponse.text()).toContain('id="transcript"');

    const postResponse = await fetch(`${url}api/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello from the web test' }),
    });
    expect(postResponse.status).toBe(201);
    const listResponse = await fetch(`${url}api/messages`);
    const listPayload = (await listResponse.json()) as { messages: { text: string }[] };
    expect(listPayload.messages.map((message) => message.text)).toEqual([
      'hello from the web test',
    ]);

    signals.emit('SIGINT');
    await expect(running).resolves.toBe(0);
    await expect(fetch(url)).rejects.toThrow();
  });

  it('prints the open fallback line when the browser cannot be opened', async () => {
    const output = collectOutput();
    const signals = new EventEmitter();
    const running = runWebWorkspace(
      { input: { isTTY: true }, output: output.stream },
      {
        startServer: () => startWebServer({ preferredPort: 0 }),
        openBrowser: () => Promise.resolve(false),
        signals,
      },
    );
    await vi.waitFor(() => {
      expect(output.text()).toContain(STOP_LINE);
    });
    expect(output.text()).toContain(
      '  open:  automatic browser open unavailable — open the url above\n',
    );
    signals.emit('SIGTERM');
    await expect(running).resolves.toBe(0);
  });

  it('never takes over the terminal: no ansi control output, no raw mode', async () => {
    const output = collectOutput();
    const rawModeSpy = vi.fn();
    const input = { isTTY: true, setRawMode: rawModeSpy };
    const signals = new EventEmitter();
    const running = runWebWorkspace(
      { input, output: output.stream },
      {
        startServer: () => startWebServer({ preferredPort: 0 }),
        openBrowser: () => Promise.resolve(true),
        signals,
      },
    );
    await vi.waitFor(() => {
      expect(output.text()).toContain(STOP_LINE);
    });
    signals.emit('SIGINT');
    await expect(running).resolves.toBe(0);
    expect(output.text()).not.toContain('\x1b[?1049h');
    expect(output.text()).not.toContain('\x1b[');
    expect(rawModeSpy).not.toHaveBeenCalled();
  });
});
