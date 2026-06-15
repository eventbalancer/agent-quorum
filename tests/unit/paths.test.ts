import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { knownStateDirs } from '../../src/runtime/paths.js';
import { withEnv } from '../helpers/harness.js';

const CLEAN_ENV = {
  AGENT_QUORUM_STATE_DIR: undefined,
  AGENT_QUORUM_PLANS_DIR: undefined,
  AGENT_QUORUM_HOME: undefined,
} as const;

describe('knownStateDirs', () => {
  it('derives the home-default and project-local stores from options', () => {
    const dirs = withEnv(CLEAN_ENV, () =>
      knownStateDirs({ home: '/tmp/qhome', cwd: '/tmp/qproj' }),
    );
    expect(dirs).toContain(path.resolve('/tmp/qhome/state'));
    expect(dirs).toContain(path.resolve('/tmp/qproj/.agents/plans/.runs'));
  });

  it('includes the AGENT_QUORUM_PLANS_DIR-derived store only when the env var is set', () => {
    const plansStore = path.resolve('/tmp/plansenv/.runs');
    const withoutPlans = withEnv(CLEAN_ENV, () =>
      knownStateDirs({ home: '/tmp/qhome', cwd: '/tmp/qproj' }),
    );
    expect(withoutPlans).not.toContain(plansStore);

    const withPlans = withEnv({ ...CLEAN_ENV, AGENT_QUORUM_PLANS_DIR: '/tmp/plansenv' }, () =>
      knownStateDirs({ home: '/tmp/qhome', cwd: '/tmp/qproj' }),
    );
    expect(withPlans).toContain(plansStore);
  });

  it('includes the ambient AGENT_QUORUM_STATE_DIR as the resolved store', () => {
    const dirs = withEnv({ ...CLEAN_ENV, AGENT_QUORUM_STATE_DIR: '/tmp/ambient-state' }, () =>
      knownStateDirs({ home: '/tmp/qhome' }),
    );
    expect(dirs).toContain(path.resolve('/tmp/ambient-state'));
    expect(dirs).toContain(path.resolve('/tmp/qhome/state'));
  });

  it('honors the cwd option without mutating process.cwd()', () => {
    const before = process.cwd();
    const dirs = withEnv(CLEAN_ENV, () =>
      knownStateDirs({ cwd: '/tmp/qproj', home: '/tmp/qhome' }),
    );
    expect(process.cwd()).toBe(before);
    expect(dirs).toContain(path.resolve('/tmp/qproj/.agents/plans/.runs'));
    expect(dirs).not.toContain(path.resolve(before, '.agents/plans/.runs'));
  });
});
