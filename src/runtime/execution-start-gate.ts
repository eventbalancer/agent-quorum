import type { ChildProcess, SpawnOptions, StdioOptions } from 'node:child_process';
import { Writable } from 'node:stream';
import { finished } from 'node:stream/promises';
import { spawnOwned } from './exec.js';

export interface ExecutionStartGate {
  readonly child: ChildProcess;
  readonly release: () => Promise<void>;
  readonly close: () => void;
}

const START_GATE_PROGRAM = String.raw`
const { accessSync, closeSync, constants, readFileSync, statSync } = require('node:fs');
const path = require('node:path');
try {
  const request = JSON.parse(readFileSync(3, 'utf8'));
  closeSync(3);
  if (request.release !== 'agent-quorum-execution-admitted' || typeof process.execve !== 'function') {
    throw new Error('execution start gate unavailable');
  }
  const candidates = request.command.includes('/')
    ? [path.resolve(request.command)]
    : (request.env.PATH ?? '/usr/bin:/bin').split(path.delimiter).map(directory => path.resolve(directory, request.command));
  const executable = candidates.find(candidate => {
    try {
      accessSync(candidate, constants.X_OK);
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (executable === undefined) {
    throw new Error('execution command unavailable');
  }
  process.execve(executable, [request.argv0, ...request.args], request.env);
} catch {
  process.stderr.write('supervised execution start failed\n');
  process.exitCode = 127;
}
`;

export function spawnExecutionStartGate(
  command: string,
  args: readonly string[],
  options: SpawnOptions,
): ExecutionStartGate {
  if (typeof process.execve !== 'function') {
    throw new TypeError('supervised execution requires process.execve');
  }
  const configuredStdio = options.stdio ?? 'pipe';
  // Node closes descriptors above stderr during execve; a shell also changes the target environment.
  if (
    options.shell ||
    (Array.isArray(configuredStdio) &&
      (configuredStdio.length > 3 || configuredStdio.includes('ipc')))
  ) {
    throw new TypeError('supervised execution requires direct argv and only stdin/stdout/stderr');
  }
  const stdio: StdioOptions = Array.isArray(configuredStdio)
    ? [...Array.from({ length: 3 }, (_, index) => configuredStdio[index] ?? 'pipe'), 'pipe']
    : [configuredStdio, configuredStdio, configuredStdio, 'pipe'];
  const environment = Object.fromEntries(
    Object.entries(options.env ?? process.env).filter((entry): entry is [string, string] => {
      return entry[1] !== undefined;
    }),
  );
  const child = spawnOwned(
    process.execPath,
    ['--no-warnings', '--input-type=commonjs', '-e', START_GATE_PROGRAM],
    { ...options, argv0: process.execPath, env: {}, stdio },
    false,
  );
  const stream = child.stdio[3];
  const pipe = stream instanceof Writable ? stream : undefined;
  pipe?.on('error', () => undefined);
  return {
    child,
    release: () => {
      if (pipe === undefined) {
        throw new Error('execution start gate pipe unavailable');
      }
      const completion = finished(pipe, { readable: false, cleanup: true });
      pipe.end(
        JSON.stringify({
          release: 'agent-quorum-execution-admitted',
          command,
          args,
          argv0: options.argv0 ?? command,
          env: environment,
        }),
      );
      return completion;
    },
    close: () => {
      pipe?.destroy();
    },
  };
}
