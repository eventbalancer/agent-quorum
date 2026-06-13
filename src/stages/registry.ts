import { planStage } from './plan/index.js';

export interface StageDescriptor {
  readonly name: string;
  readonly summary: string;
  readonly usage: string;
  run(args: readonly string[]): Promise<number>;
}

export const stages: readonly StageDescriptor[] = [planStage];

export function findStage(name: string): StageDescriptor | undefined {
  return stages.find((stage) => stage.name === name);
}
