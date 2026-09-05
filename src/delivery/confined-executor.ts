import path from 'node:path';
import { DeliveryError } from './contract.js';

export const LOCAL_DOCKER_ARGS = ['--host', 'unix:///var/run/docker.sock'] as const;

export interface DockerExecutorInput {
  readonly image: string;
  readonly worktree: string;
  readonly runtimeRoot: string;
  readonly readOnlyWorktree?: boolean;
  readonly artifactRoot?: string;
  readonly environment?: Readonly<Record<string, string>>;
}

export function dockerExecutorArgs(
  input: DockerExecutorInput,
  command: readonly string[],
): string[] {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:~-]*@sha256:[a-f0-9]{64}$/.test(input.image)) {
    throw new DeliveryError('docker-image-must-be-digest-pinned', true);
  }
  if (
    [
      input.worktree,
      input.runtimeRoot,
      ...(input.artifactRoot === undefined ? [] : [input.artifactRoot]),
    ].some(
      (directory) =>
        !path.isAbsolute(directory) ||
        /[,\r\n]/.test(directory) ||
        ['/aq-toolchain', '/aq-harness'].some(
          (reserved) => directory === reserved || directory.startsWith(`${reserved}/`),
        ),
    ) ||
    command.length === 0
  ) {
    throw new DeliveryError('invalid-container-executor-path', true);
  }
  return [
    ...LOCAL_DOCKER_ARGS,
    'run',
    '--rm',
    '--interactive',
    '--pull=never',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '--pids-limit=256',
    '--memory=4g',
    '--cpus=2',
    '--ipc=private',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,mode=1777,size=2147483648',
    '--mount',
    `type=bind,source=${input.worktree},target=${input.worktree}${input.readOnlyWorktree === true ? ',readonly' : ''}`,
    '--mount',
    `type=bind,source=${input.runtimeRoot},target=/aq-harness,readonly`,
    ...(input.artifactRoot === undefined
      ? []
      : [
          '--mount',
          `type=bind,source=${input.artifactRoot},target=${input.artifactRoot}`,
          '--mount',
          `type=bind,source=${input.artifactRoot}/input.md,target=${input.artifactRoot}/input.md,readonly`,
        ]),
    '--workdir',
    input.worktree,
    '--env',
    'HOME=/tmp/home',
    '--env',
    'TMPDIR=/tmp',
    '--env',
    'CI=1',
    '--env',
    'NODE_OPTIONS=',
    '--env',
    'GIT_CONFIG_NOSYSTEM=1',
    '--env',
    'GIT_CONFIG_GLOBAL=/dev/null',
    '--env',
    'GIT_TERMINAL_PROMPT=0',
    ...Object.entries(input.environment ?? {}).flatMap(([key, value]) => {
      if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || value.includes('\0')) {
        throw new DeliveryError('invalid-container-environment', true);
      }
      return ['--env', `${key}=${value}`];
    }),
    '--entrypoint',
    'python3',
    input.image,
    '/aq-harness/src/delivery/container-watchdog.py',
    ...command,
  ];
}
