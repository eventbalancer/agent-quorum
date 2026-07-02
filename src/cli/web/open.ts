import { spawn } from 'node:child_process';

const OPEN_TIMEOUT_MS = 2000;

export interface OpenInBrowserDeps {
  readonly platform?: NodeJS.Platform;
  readonly spawnFn?: typeof spawn;
  readonly timeoutMs?: number;
}

interface OpenerCommand {
  readonly command: string;
  readonly args: readonly string[];
}

function isSuccessfulOpenerExit(code: number | null, signal: NodeJS.Signals | null): boolean {
  return code === 0 && signal === null;
}

function openerCommand(url: string, platform: NodeJS.Platform): OpenerCommand {
  if (platform === 'darwin') {
    return { command: 'open', args: [url] };
  }
  if (platform === 'win32') {
    return { command: 'cmd', args: ['/c', 'start', '', url] };
  }
  return { command: 'xdg-open', args: [url] };
}

// Resolves from the child's outcome, not the spawn event: a spawned opener can
// still fail (xdg-open exits nonzero with no browser). A child that outlives
// timeoutMs counts as a successful hand-off so the awaited call stays bounded.
// Never rejects — the caller's fallback is the printed URL.
export function openInBrowser(url: string, deps: OpenInBrowserDeps = {}): Promise<boolean> {
  const platform = deps.platform ?? process.platform;
  const spawnFn = deps.spawnFn ?? spawn;
  const timeoutMs = deps.timeoutMs ?? OPEN_TIMEOUT_MS;
  const opener = openerCommand(url, platform);
  return new Promise((resolve) => {
    let settled = false;
    const settle = (didOpen: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve(didOpen);
    };
    const timer = setTimeout(() => {
      settle(true);
    }, timeoutMs);
    const child = spawnFn(opener.command, [...opener.args], {
      detached: true,
      stdio: 'ignore',
    });
    child.once('exit', (code, signal) => {
      settle(isSuccessfulOpenerExit(code, signal));
    });
    child.once('error', () => {
      settle(false);
    });
    child.unref();
  });
}
