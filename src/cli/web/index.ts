import { HaltError } from '../../runtime/halt.js';
import { openInBrowser } from './open.js';
import { DEFAULT_WEB_PORT, startWebServer, WEB_HOST, type WebServerHandle } from './server.js';

export interface WorkspaceStreams {
  readonly input: { isTTY?: boolean };
  readonly output: { write(text: string): boolean; isTTY?: boolean };
}

export function shouldStartWorkspace(
  args: readonly string[],
  input: { isTTY?: boolean },
  output: { isTTY?: boolean },
): boolean {
  return args.length === 0 && input.isTTY === true && output.isTTY === true;
}

export interface WorkspaceDispatchDeps {
  readonly runWorkspace: (streams: WorkspaceStreams) => Promise<number>;
  readonly writeHelp: () => void;
}

export async function openWorkspaceOrHelp(
  streams: WorkspaceStreams,
  deps: WorkspaceDispatchDeps,
): Promise<number> {
  if (shouldStartWorkspace([], streams.input, streams.output)) {
    return deps.runWorkspace(streams);
  }
  deps.writeHelp();
  return 0;
}

export interface RunWebWorkspaceDeps {
  readonly startServer: typeof startWebServer;
  readonly openBrowser: (url: string) => Promise<boolean>;
  readonly signals: NodeJS.EventEmitter;
}

const defaultRunWebWorkspaceDeps: RunWebWorkspaceDeps = {
  startServer: startWebServer,
  openBrowser: openInBrowser,
  signals: process,
};

const WORKSPACE_PORT_BUSY_NOTE_PREFIX = '  note:  preferred port ';
const WORKSPACE_PORT_BUSY_NOTE_SUFFIX = ' busy — using an ephemeral port\n';
const WORKSPACE_OPEN_UNAVAILABLE_LINE =
  '  open:  automatic browser open unavailable — open the url above\n';
const WORKSPACE_CHAT_LINE =
  '  chat:  local first slice — messages stay in this process and are discarded on exit\n';
const WORKSPACE_STOP_LINE = '  stop:  Ctrl-C stops the local server\n';

function bindFailureCode(error: unknown): string {
  if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof Error ? error.message : String(error);
}

function waitForFirstStopSignal(signals: NodeJS.EventEmitter): Promise<void> {
  return new Promise((resolve) => {
    const onSigint = (): void => {
      signals.removeListener('SIGTERM', onSigterm);
      resolve();
    };
    const onSigterm = (): void => {
      signals.removeListener('SIGINT', onSigint);
      resolve();
    };
    signals.once('SIGINT', onSigint);
    signals.once('SIGTERM', onSigterm);
  });
}

export async function runWebWorkspace(
  streams: WorkspaceStreams,
  deps: RunWebWorkspaceDeps = defaultRunWebWorkspaceDeps,
): Promise<number> {
  let handle: WebServerHandle;
  try {
    handle = await deps.startServer();
  } catch (error) {
    throw new HaltError(
      `web workspace: cannot bind http://${WEB_HOST}: ${bindFailureCode(error)}`,
      1,
    );
  }
  streams.output.write(`workspace: ${handle.url}\n`);
  if (handle.usedFallback) {
    streams.output.write(
      `${WORKSPACE_PORT_BUSY_NOTE_PREFIX}${String(DEFAULT_WEB_PORT)}${WORKSPACE_PORT_BUSY_NOTE_SUFFIX}`,
    );
  }
  const didOpen = await deps.openBrowser(handle.url);
  if (!didOpen) {
    streams.output.write(WORKSPACE_OPEN_UNAVAILABLE_LINE);
  }
  streams.output.write(WORKSPACE_CHAT_LINE);
  streams.output.write(WORKSPACE_STOP_LINE);
  await waitForFirstStopSignal(deps.signals);
  await handle.close();
  return 0;
}
