import os from 'node:os';
import path from 'node:path';

export interface ArtifactRoots {
  readonly home: string;
  readonly runsDir: string;
  readonly stateDir: string;
}

export interface ArtifactRootOverrides {
  readonly home?: string;
}

// Single resolver for run artifact roots. The default root is `~/.agent-quorum`;
// the `AGENT_QUORUM_PLANS_DIR`-only branch preserves the legacy layout where
// state nests beside plans.
export function resolveArtifactRoots(overrides: ArtifactRootOverrides = {}): ArtifactRoots {
  const env = process.env;
  const home = overrides.home ?? env.AGENT_QUORUM_HOME ?? path.join(os.homedir(), '.agent-quorum');
  const runsDir = env.AGENT_QUORUM_PLANS_DIR ?? path.join(home, 'runs');
  const stateDir =
    env.AGENT_QUORUM_STATE_DIR ??
    (env.AGENT_QUORUM_PLANS_DIR
      ? path.join(env.AGENT_QUORUM_PLANS_DIR, '.runs')
      : path.join(home, 'state'));
  return { home, runsDir, stateDir };
}

export interface KnownStoreOptions {
  readonly home?: string;
  readonly cwd?: string;
}

// Bounded read-only discovery set, in stable order: ambient resolved store,
// home-default store, legacy plans-derived store, and project-local self-plans.
export function knownStateDirs(options: KnownStoreOptions = {}): readonly string[] {
  const env = process.env;
  const homeRoot =
    options.home ?? env.AGENT_QUORUM_HOME ?? path.join(os.homedir(), '.agent-quorum');
  const cwd = options.cwd ?? process.cwd();
  const dirs = [
    resolveArtifactRoots(options.home !== undefined ? { home: options.home } : {}).stateDir,
    path.join(homeRoot, 'state'),
  ];
  if (env.AGENT_QUORUM_PLANS_DIR) {
    dirs.push(path.join(env.AGENT_QUORUM_PLANS_DIR, '.runs'));
  }
  dirs.push(path.join(cwd, '.agents', 'plans', '.runs'));
  return dirs.map((dir) => path.resolve(dir));
}
