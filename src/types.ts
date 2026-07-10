import type { DeepPartial, OperatorConfig } from './core/config.js';

export type { Runner } from './providers/registry.js';

export type Role = 'creator' | 'critic' | 'fixer' | 'reviewer' | 'translator' | 'judge';

export type Quality = 'quick' | 'balanced' | 'thorough';

export type RunMode = 'plan' | 'prompt';

export type RunFinalStatus = 'clean' | 'needs-review' | 'blocked';

export type ReadinessLabel = 'ready' | 'not-ready' | 'unknown';

export interface FinalReadiness {
  readonly evaluated: boolean;
  readonly ready: boolean | null;
  readonly rationale: string;
  readonly planSha256: string;
}

export function readinessLabel(ready: FinalReadiness['ready']): ReadinessLabel {
  if (ready === null) {
    return 'unknown';
  }
  return ready ? 'ready' : 'not-ready';
}

export interface RunOverrides {
  readonly workDir?: string;
  readonly home?: string;
  readonly config?: DeepPartial<OperatorConfig>;
  readonly secrets?: { readonly telegramBotToken?: string };
}
