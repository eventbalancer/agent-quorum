import { describe, expect, it } from 'vitest';
import { digest, type AcceptanceCriterion } from '../../src/delivery/contract.js';
import {
  admitReview,
  admitVerification,
  type ReviewReceipt,
  type VerificationReceipt,
} from '../../src/delivery/evidence.js';
import {
  admitLiveReceipt,
  isLiveReuseEligible,
  needsLiveGate,
  validateLiveExecutionSummary,
  type LiveReceipt,
} from '../../src/delivery/live-evidence.js';

const CANDIDATE = 'a'.repeat(64);
const CRITERIA: readonly AcceptanceCriterion[] = [
  { id: 'AC-1', outcome: 'Preserve the requested outcome', evidence: ['src/current.ts:1'] },
];

function review(): ReviewReceipt {
  return {
    invocationId: 'reviewer',
    implementationInvocationId: 'implementer',
    candidate: CANDIDATE,
    acceptanceDigest: digest(CRITERIA),
    approved: true,
    findings: [],
    acceptanceEvidence: CRITERIA,
    adjacentFindings: [],
    liveReuseApproved: false,
    interveningDiffDigest: '',
  };
}

function verification(): VerificationReceipt {
  return {
    candidate: CANDIDATE,
    inputsDigest: CANDIDATE,
    policyDigest: 'policy',
    checks: ['check', 'test'].map((name) => ({
      command: ['pnpm', 'run', name],
      exitCode: 0,
      outputDigest: 'b'.repeat(64),
    })),
  };
}

function live(): LiveReceipt {
  return {
    testedRevision: 'a'.repeat(40),
    candidate: CANDIDATE,
    inputDigest: 'inputs',
    outputDir: '/private/evidence',
    passedScenarios: ['standard-create-ready', 'high-revise-judge-ready'],
    applicabilityDiffDigest: '',
    reviewerInvocationId: '',
  };
}

describe('delivery evidence admission', () => {
  it('requires a distinct identified reviewer and current acceptance/candidate identity', () => {
    expect(() => {
      admitReview(review(), CANDIDATE, CRITERIA);
    }).not.toThrow();
    for (const changed of [
      { invocationId: 'implementer' },
      { invocationId: '' },
      { implementationInvocationId: '' },
      { candidate: 'old' },
      { acceptanceDigest: 'old' },
    ]) {
      expect(() => {
        admitReview({ ...review(), ...changed }, CANDIDATE, CRITERIA);
      }).toThrow('stale-or-nonindependent-review');
    }
  });

  it('blocks unresolved findings and unsupported dismissals without weakening acceptance', () => {
    const finding = {
      id: 'R1',
      material: true,
      description: 'Missing behavior',
      evidence: ['src/current.ts:1'],
      resolution: 'open' as const,
      resolutionEvidence: [],
    };
    expect(() => {
      admitReview({ ...review(), findings: [finding] }, CANDIDATE, CRITERIA);
    }).toThrow('material-review-findings');
    expect(() => {
      admitReview(
        {
          ...review(),
          findings: [{ ...finding, resolution: 'dismissed', resolutionEvidence: [' '] }],
        },
        CANDIDATE,
        CRITERIA,
      );
    }).toThrow('material-review-findings');
    expect(() => {
      admitReview(
        {
          ...review(),
          acceptanceEvidence: [
            { id: 'AC-1', outcome: 'A weaker outcome', evidence: ['src/current.ts:1'] },
          ],
        },
        CANDIDATE,
        CRITERIA,
      );
    }).toThrow('acceptance-evidence-incomplete');
  });

  it('requires actual command identities and successful current local verification', () => {
    expect(() => {
      admitVerification(verification(), CANDIDATE, CANDIDATE, 'policy', true);
    }).not.toThrow();
    expect(() => {
      admitVerification(verification(), 'old', CANDIDATE, 'policy', true);
    }).toThrow('stale-verification');
    const forged = {
      ...verification(),
      checks: verification().checks.map((check) => ({
        ...check,
        command: [check.command.join(' ')],
      })),
    };
    expect(() => {
      admitVerification(forged, CANDIDATE, CANDIDATE, 'policy', true);
    }).toThrow('required-local-check-missing');
    const failed = {
      ...verification(),
      checks: verification().checks.map((check) => ({ ...check, exitCode: 1 })),
    };
    expect(() => {
      admitVerification(failed, CANDIDATE, CANDIDATE, 'policy', true);
    }).toThrow('required-local-check-missing');
  });

  it('admits exactly the mandatory live pair and invalidates changed inputs', () => {
    expect(() => {
      admitLiveReceipt(live(), CANDIDATE, 'inputs', review());
    }).not.toThrow();
    expect(() => {
      admitLiveReceipt(live(), CANDIDATE, 'changed-inputs', review());
    }).toThrow('required-live-gate-incomplete');
    expect(() => {
      admitLiveReceipt(
        { ...live(), passedScenarios: ['standard-create-ready'] },
        CANDIDATE,
        'inputs',
        review(),
      );
    }).toThrow('required-live-gate-incomplete');
    expect(() => {
      admitLiveReceipt(
        { ...live(), passedScenarios: [...live().passedScenarios, 'standard-create-ready'] },
        CANDIDATE,
        'inputs',
        review(),
      );
    }).toThrow('required-live-gate-incomplete');
  });

  it('requires a current independently reviewed exact diff to reuse historical evidence', () => {
    const candidate = 'b'.repeat(64);
    expect(() => {
      admitLiveReceipt(live(), candidate, 'inputs', review());
    }).toThrow('stale-live-evidence');
    const applicability = 'c'.repeat(64);
    const currentReview = {
      ...review(),
      candidate,
      liveReuseApproved: true,
      interveningDiffDigest: applicability,
    };
    expect(() => {
      admitLiveReceipt(
        {
          ...live(),
          applicabilityDiffDigest: applicability,
          reviewerInvocationId: currentReview.invocationId,
        },
        candidate,
        'inputs',
        currentReview,
      );
    }).not.toThrow();
    expect(() => {
      admitLiveReceipt(
        {
          ...live(),
          applicabilityDiffDigest: 'different',
          reviewerInvocationId: currentReview.invocationId,
        },
        candidate,
        'inputs',
        currentReview,
      );
    }).toThrow('stale-live-evidence');
  });

  it('treats role prompts, provider paths and policies as live inputs while ordinary docs can reuse evidence', () => {
    expect(needsLiveGate(['README.md'], '')).toBe(false);
    expect(needsLiveGate(['README.md'], 'Unresolved integration question')).toBe(true);
    expect(needsLiveGate(['skills/creator/SKILL.md'], '')).toBe(true);
    expect(needsLiveGate(['src/providers/codex.ts'], '')).toBe(true);
    expect(isLiveReuseEligible(['README.md', 'docs/usage-examples.md'])).toBe(true);
    expect(isLiveReuseEligible(['docs/release.md'])).toBe(false);
    expect(isLiveReuseEligible(['skills/reviewer/SKILL.md'])).toBe(false);
  });

  it('never admits a summary or file-existence assertion without revalidated raw receipts', async () => {
    await expect(
      validateLiveExecutionSummary(
        JSON.stringify({ schemaVersion: 1, passed: true, scenarios: [] }),
        '/missing/output',
      ),
    ).rejects.toThrow();
  });
});
