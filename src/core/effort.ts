import { HaltError } from '../runtime/halt.js';

export type CritiquesMode = 'compact' | 'full';

export interface EffortMatrix {
  sessionMode: 0 | 1;
  creatorOneShot: 0 | 1;
  previousCritiques: CritiquesMode;
  topology: CritiquesMode;
}

const EFFORT_ERROR = '--effort expects low, high, or max';

export function effortMatrix(effort: string): EffortMatrix {
  switch (effort) {
    case 'low':
      return {
        sessionMode: 1,
        creatorOneShot: 1,
        previousCritiques: 'compact',
        topology: 'compact',
      };
    case 'high':
      return { sessionMode: 1, creatorOneShot: 0, previousCritiques: 'full', topology: 'full' };
    case 'max':
      return { sessionMode: 0, creatorOneShot: 0, previousCritiques: 'full', topology: 'full' };
    default:
      throw new HaltError(EFFORT_ERROR, 1);
  }
}
