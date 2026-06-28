import { describe, expect, it } from 'vitest';
import { RUNNER_META, RUNNERS } from '../../src/providers/registry.js';
import { QUALITY_VALUES, isQuality, qualityMatrix, reasoningFor } from '../../src/core/quality.js';
import type { Role } from '../../src/types.js';

const TOP_TIER: readonly Role[] = ['creator'];
const HIGH_TIER: readonly Role[] = ['critic', 'judge'];
const BASE_TIER: readonly Role[] = ['fixer', 'reviewer', 'translator'];
const LADDER = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
const rank = (value: string): number => LADDER.indexOf(value as (typeof LADDER)[number]);

describe('qualityMatrix', () => {
  it('maps quick/balanced/thorough to topology knobs', () => {
    expect(qualityMatrix('quick')).toEqual({
      sessionMode: 1,
      creatorOneShot: 1,
      previousCritiques: 'compact',
      topology: 'compact',
      judge: 0,
    });
    expect(qualityMatrix('balanced')).toEqual({
      sessionMode: 1,
      creatorOneShot: 0,
      previousCritiques: 'full',
      topology: 'full',
      judge: 1,
    });
    expect(qualityMatrix('thorough')).toEqual({
      sessionMode: 0,
      creatorOneShot: 0,
      previousCritiques: 'full',
      topology: 'full',
      judge: 1,
    });
  });

  it('accepts the three dial values and rejects others', () => {
    expect(QUALITY_VALUES).toEqual(['quick', 'balanced', 'thorough']);
    for (const value of QUALITY_VALUES) {
      expect(isQuality(value)).toBe(true);
    }
    expect(isQuality('high')).toBe(false);
    expect(isQuality('')).toBe(false);
  });
});

describe('reasoningFor', () => {
  it('returns the empty string for cursor at every role and quality', () => {
    for (const quality of QUALITY_VALUES) {
      for (const role of [...TOP_TIER, ...HIGH_TIER, ...BASE_TIER]) {
        expect(reasoningFor(quality, 'cursor', role)).toBe('');
      }
    }
  });

  it('keeps the high tier one rung above the base tier per quality (codex/claude)', () => {
    for (const runner of ['codex', 'claude'] as const) {
      for (const quality of QUALITY_VALUES) {
        const base = reasoningFor(quality, runner, 'fixer');
        const high = reasoningFor(quality, runner, 'critic');
        expect(rank(base)).toBeGreaterThanOrEqual(0);
        if (quality === 'thorough') {
          expect(high).toBe('max');
        } else {
          expect(rank(high)).toBe(rank(base) + 1);
        }
        for (const role of BASE_TIER) {
          expect(reasoningFor(quality, runner, role)).toBe(base);
        }
        for (const role of HIGH_TIER) {
          expect(reasoningFor(quality, runner, role)).toBe(high);
        }
      }
    }
  });

  it('runs the creator at the high tier below thorough and at max for thorough (codex/claude)', () => {
    for (const runner of ['codex', 'claude'] as const) {
      const high = reasoningFor('quick', runner, 'critic');
      expect(reasoningFor('quick', runner, 'creator')).toBe(high);
      expect(reasoningFor('balanced', runner, 'creator')).toBe(
        reasoningFor('balanced', runner, 'critic'),
      );
      expect(reasoningFor('thorough', runner, 'creator')).toBe('max');
      expect(reasoningFor('thorough', runner, 'critic')).toBe('max');
    }
  });

  it('is strictly monotonic per role: thorough exceeds quick (codex/claude)', () => {
    for (const runner of ['codex', 'claude'] as const) {
      for (const role of [...TOP_TIER, ...HIGH_TIER, ...BASE_TIER]) {
        expect(rank(reasoningFor('thorough', runner, role))).toBeGreaterThan(
          rank(reasoningFor('quick', runner, role)),
        );
      }
    }
  });
});

describe('RUNNER_META.defaultModel', () => {
  it('every runner has a non-empty default model', () => {
    for (const runner of RUNNERS) {
      expect(typeof RUNNER_META[runner].defaultModel).toBe('string');
      expect(RUNNER_META[runner].defaultModel.length).toBeGreaterThan(0);
    }
  });
});
