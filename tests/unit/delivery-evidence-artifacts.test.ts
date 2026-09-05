import { describe, expect, it } from 'vitest';
import { planningArtifactsNeedDecoder } from '../../src/delivery/evidence-artifacts.js';
import { FINAL_JUDGE_METADATA } from '../../src/stages/plan/judge.js';

describe('planning artifact decoder selection', () => {
  it.each([
    { schemaVersion: 2, expected: false },
    { schemaVersion: 3, expected: true },
  ])(
    'routes Judge metadata version $schemaVersion from its actual producer',
    ({ schemaVersion, expected }) => {
      const bundle = JSON.stringify({
        version: 1,
        files: { [`run/${FINAL_JUDGE_METADATA}`]: JSON.stringify({ schemaVersion }) },
      });
      expect(planningArtifactsNeedDecoder(bundle)).toBe(expected);
    },
  );

  it('does not grant decoder admission to an unrelated lookalike artifact', () => {
    expect(
      planningArtifactsNeedDecoder(
        JSON.stringify({
          version: 1,
          files: { 'run/judge-meta.final.json': JSON.stringify({ schemaVersion: 3 }) },
        }),
      ),
    ).toBe(false);
  });
});
