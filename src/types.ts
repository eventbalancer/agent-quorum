import type { DeepPartial, OperatorConfig } from './core/config.js';

export type { Runner } from './providers/registry.js';

export type Role = 'creator' | 'critic' | 'fixer' | 'reviewer' | 'translator' | 'judge';

export type Quality = 'quick' | 'balanced' | 'thorough';

export type RunMode = 'plan' | 'prompt';

export interface RunOverrides {
  readonly workDir?: string;
  readonly home?: string;
  readonly config?: DeepPartial<OperatorConfig>;
  readonly secrets?: { readonly telegramBotToken?: string };
}
