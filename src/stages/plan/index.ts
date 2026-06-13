import type { StageDescriptor } from '../registry.js';
import { RUN_USAGE, runPlanLoopCli } from './run.js';

export const planStage: StageDescriptor = {
  name: 'plan',
  summary: 'iterate plan → critique → update over a prompt or plan file',
  usage: RUN_USAGE,
  run: async (args) => {
    const outcome = await runPlanLoopCli(args);
    return outcome.exitCode;
  },
};
