import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertToolchainSnapshot, gateCommands, toolEntrypoint } from './gate-toolchain.js';
import { writeGateConfigurations } from './gate-configurations.js';

export async function runFrozenGate(
  toolchain: string,
  frozenRoot: string,
  worktree: string,
  args: readonly string[],
): Promise<number> {
  assertToolchainSnapshot(frozenRoot, toolchain);
  const directory = mkdtempSync(path.join(os.tmpdir(), 'aq-frozen-gate-'));
  try {
    const configs = writeGateConfigurations(toolchain, worktree, directory);
    const commands =
      args[0] === 'live'
        ? [{ tool: 'tsx' as const, args: args.slice(1) }]
        : gateCommands(args, toolchain, configs, worktree);
    for (const command of commands) {
      if ('cleanBuild' in command && command.cleanBuild) {
        rmSync(path.join(worktree, 'dist'), { recursive: true, force: true });
      }
      const exitCode = await new Promise<number>((resolve) => {
        const child = spawn(
          process.execPath,
          [toolEntrypoint(toolchain, command.tool), ...command.args],
          {
            cwd: worktree,
            stdio: 'inherit',
            env: {
              ...process.env,
              NODE_OPTIONS: `--import ${pathToFileURL(path.join(frozenRoot, 'src/delivery/gate-resolution.mjs')).href}`,
              AGENT_QUORUM_GATE_TOOLCHAIN: toolchain,
            },
          },
        );
        child.once('error', () => {
          resolve(127);
        });
        child.once('exit', (code) => {
          resolve(code ?? 1);
        });
      });
      if (exitCode !== 0) {
        return exitCode;
      }
    }
    return 0;
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (pathToFileURL(path.resolve(process.argv[1] ?? '')).href === import.meta.url) {
  const [toolchain, frozenRoot, worktree, ...args] = process.argv.slice(2);
  try {
    if (
      toolchain === undefined ||
      frozenRoot === undefined ||
      worktree === undefined ||
      ![toolchain, frozenRoot, worktree].every(path.isAbsolute)
    ) {
      throw new Error('frozen gate paths required');
    }
    process.exitCode = await runFrozenGate(toolchain, frozenRoot, worktree, args);
  } catch {
    process.stderr.write('frozen gate toolchain unavailable or incompatible\n');
    process.exitCode = 2;
  }
}
