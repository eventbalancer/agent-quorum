export type { Runner } from './providers/registry.js';

export type Role = 'critic' | 'creator' | 'fixer' | 'reviewer' | 'translator';

export type Effort = 'low' | 'high' | 'max';

export type RunMode = 'plan' | 'prompt';

export interface RunOverrides {
  readonly workDir?: string;
  readonly configFile?: string;
  readonly home?: string;
}
