import { describe, expect, it, vi } from 'vitest';
import {
  assertNoStageOrphans,
  assertStageProcessesStopped,
} from '../../src/delivery/process-supervision.js';

describe('owned stage process supervision', () => {
  it('admits live descendants and refuses a helper reparented outside the owned group', () => {
    const root = { pid: 100, parentPid: 10, group: 100, state: 'S' };
    const provider = { pid: 101, parentPid: 100, group: 100, state: 'S' };
    const helper = { pid: 102, parentPid: 101, group: 100, state: 'S' };
    expect(() => {
      assertNoStageOrphans('100', () => [root, provider, helper]);
    }).not.toThrow();
    expect(() => {
      assertNoStageOrphans('100', () => [root, { ...helper, parentPid: 1 }]);
    }).toThrow('orphaned-provider-process');
  });

  it('waits for demonstrated group cleanup before acknowledging completion', async () => {
    const read = vi
      .fn()
      .mockReturnValueOnce([{ pid: 102, parentPid: 1, group: 100, state: 'S' }])
      .mockReturnValue([]);
    await assertStageProcessesStopped('100', read);
    expect(read).toHaveBeenCalledTimes(2);
  });
});
