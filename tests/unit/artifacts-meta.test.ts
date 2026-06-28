import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupRunRegistry,
  renderRunMetadata,
  writeRunMetadata,
  type RunMetadata,
} from '../../src/core/artifacts.js';

const REFERENCE_KEY_ORDER = [
  'pid',
  'pgid',
  'mode',
  'input_path',
  'work_dir',
  'plans_dir',
  'log_path',
  'interventions_path',
  'started_at',
  'quality',
  'session_mode',
  'creator_one_shot',
  'previous_critiques',
  'topology',
  'max_iters',
  'fix_pass',
  'diff_threshold',
  'creator_runner',
  'creator_model',
  'creator_reasoning',
  'creator_create_tools',
  'creator_create_disallowed_tools',
  'creator_update_tools',
  'creator_update_disallowed_tools',
  'critic_runner',
  'critic_model',
  'critic_reasoning',
  'critic_tools',
  'critic_disallowed_tools',
  'fixer_runner',
  'fixer_model',
  'fixer_reasoning',
  'fixer_tools',
  'fixer_disallowed_tools',
  'reviewer_runner',
  'reviewer_model',
  'reviewer_reasoning',
  'reviewer_tools',
  'reviewer_disallowed_tools',
  'judge_runner',
  'judge_model',
  'judge_reasoning',
  'judge_tools',
  'judge_disallowed_tools',
];

function sampleMeta(workDir: string): RunMetadata {
  return {
    pid: 4242,
    pgid: '4242',
    mode: 'plan',
    inputPath: '/tmp/in.md',
    workDir,
    plansDir: '/tmp/plans',
    startedAt: '2026-06-10T00:00:00Z',
    quality: 'balanced',
    sessionMode: '1',
    creatorOneShot: '0',
    previousCritiques: 'full',
    topology: 'full',
    maxIters: 5,
    fixPass: '1',
    diffThreshold: 10,
    critic: { runner: 'codex', model: 'm', reasoning: 'high', tools: 't', disallowedTools: 'd' },
    creator: {
      runner: 'claude',
      model: 'm2',
      reasoning: 'r2',
      createTools: 'ct',
      createDisallowedTools: 'cd',
      updateTools: 'ut',
      updateDisallowedTools: 'ud',
    },
    fixer: { runner: 'claude', model: 'm3', reasoning: 'r3', tools: 't3', disallowedTools: 'd3' },
    reviewer: { runner: 'codex', model: 'm4', reasoning: 'r4', tools: 't4', disallowedTools: 'd4' },
    judge: { runner: 'claude', model: 'm5', reasoning: 'r5', tools: 't5', disallowedTools: 'd5' },
    runId: 'r000000abc-0123456789abcdef0123',
    name: 'in',
  };
}

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-metatest.'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('run metadata', () => {
  it('keeps the reference key sequence as a prefix and appends run_id + name', () => {
    const rendered = renderRunMetadata(sampleMeta('/tmp/work'));
    const keys = rendered
      .trimEnd()
      .split('\n')
      .map((line) => line.split('\t')[0]);
    expect(keys.slice(0, REFERENCE_KEY_ORDER.length)).toEqual(REFERENCE_KEY_ORDER);
    expect(keys.slice(REFERENCE_KEY_ORDER.length)).toEqual(['run_id', 'name']);
    expect(rendered).toContain(`log_path\t${path.join('/tmp/work', 'run.log')}\n`);
    expect(rendered).toContain(
      `interventions_path\t${path.join('/tmp/work', 'operator-interventions.jsonl')}\n`,
    );
    expect(rendered).toContain('run_id\tr000000abc-0123456789abcdef0123\n');
    expect(rendered).toContain('name\tin\n');
  });

  it('writes both meta and registry files atomically and cleans the registry', () => {
    const metaFile = path.join(dir, 'run.meta.tsv');
    const registryFile = path.join(dir, '4242.tsv');
    writeRunMetadata(metaFile, registryFile, sampleMeta(dir));
    expect(readFileSync(metaFile, 'utf8')).toBe(readFileSync(registryFile, 'utf8'));
    cleanupRunRegistry(registryFile);
    expect(() => readFileSync(registryFile, 'utf8')).toThrow();
    cleanupRunRegistry(registryFile);
  });
});
