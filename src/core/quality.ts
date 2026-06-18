import type { Quality, Role, Runner } from '../types.js';

export type CritiquesMode = 'compact' | 'full';

export interface QualityMatrix {
  sessionMode: 0 | 1;
  creatorOneShot: 0 | 1;
  previousCritiques: CritiquesMode;
  topology: CritiquesMode;
}

export const QUALITY_VALUES: readonly Quality[] = ['quick', 'balanced', 'thorough'];

export function isQuality(value: string): value is Quality {
  return (QUALITY_VALUES as readonly string[]).includes(value);
}

export function formatQualityHint(): string {
  return QUALITY_VALUES.join(', ');
}

export function qualityMatrix(quality: Quality): QualityMatrix {
  switch (quality) {
    case 'quick':
      return {
        sessionMode: 1,
        creatorOneShot: 1,
        previousCritiques: 'compact',
        topology: 'compact',
      };
    case 'balanced':
      return {
        sessionMode: 1,
        creatorOneShot: 0,
        previousCritiques: 'full',
        topology: 'full',
      };
    case 'thorough':
      return {
        sessionMode: 0,
        creatorOneShot: 0,
        previousCritiques: 'full',
        topology: 'full',
      };
  }
}

// Reasoning is derived from quality at runtime, never stored. The high tier
// (critic) sits one rung above the base tier on a shared codex/claude ladder;
// the creator tracks the high tier except at thorough, where it reaches max.
// cursor ignores reasoning and warns on a non-empty value, so it always
// resolves to ''.
const TOP_TIER_ROLES: ReadonlySet<Role> = new Set<Role>(['creator']);
const HIGH_TIER_ROLES: ReadonlySet<Role> = new Set<Role>(['critic']);

interface ReasoningLadderRung {
  base: string;
  high: string;
  top: string;
}

const REASONING_LADDER: Record<Quality, ReasoningLadderRung> = {
  quick: {
    base: 'low',
    high: 'medium',
    top: 'medium',
  },
  balanced: {
    base: 'medium',
    high: 'high',
    top: 'high',
  },
  thorough: {
    base: 'high',
    high: 'xhigh',
    top: 'max',
  },
};

export function reasoningFor(quality: Quality, runner: Runner, role: Role): string {
  if (runner === 'cursor') {
    return '';
  }
  const rung = REASONING_LADDER[quality];
  if (TOP_TIER_ROLES.has(role)) {
    return rung.top;
  }
  return HIGH_TIER_ROLES.has(role) ? rung.high : rung.base;
}
