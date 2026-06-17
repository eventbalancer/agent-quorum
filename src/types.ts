import type { DeepPartial, OperatorConfig } from './core/config.js';

export type { Runner } from './providers/registry.js';

export type Role = 'critic' | 'creator' | 'fixer' | 'reviewer' | 'translator';

export type Effort = 'low' | 'high' | 'max';

export type RunMode = 'plan' | 'prompt';

export interface RunOverrides {
  readonly workDir?: string;
  readonly home?: string;
  readonly config?: DeepPartial<OperatorConfig>;
  readonly secrets?: { readonly telegramBotToken?: string };
}
