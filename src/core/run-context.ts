import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ProviderRuntime } from '../providers/runtime.js';
import type { ResolvedConfig, RolePermissions, RunSettings } from './config.js';
import type { QualityMatrix } from './quality.js';
import type { PassKnobs } from './knobs.js';
import type { SplitPolicy } from './split-policy.js';
import type { RunMode } from '../types.js';

export interface SkillPaths {
  criticSkill: string;
  criticSchema: string;
  creatorSkill: string;
  creatorSchema: string;
  creatorMetaSchema: string;
  clarifySchema: string;
  fixerSkill: string;
  reviewerSkill: string;
  reviewerSchema: string;
  translatorSkill: string;
  markdownSchema: string;
  judgeSkill: string;
  judgeSchema: string;
}

export function skillPaths(packageRootDir: string): SkillPaths {
  const skills = path.join(packageRootDir, 'skills');
  return {
    criticSkill: path.join(skills, 'plan-critic', 'SKILL.md'),
    criticSchema: path.join(skills, 'plan-critic', 'critique.schema.json'),
    creatorSkill: path.join(skills, 'plan-creator', 'SKILL.md'),
    creatorSchema: path.join(skills, 'plan-creator', 'update.schema.json'),
    creatorMetaSchema: path.join(skills, 'plan-creator', 'update-meta.schema.json'),
    clarifySchema: path.join(skills, 'plan-creator', 'clarify.schema.json'),
    fixerSkill: path.join(skills, 'plan-fixer', 'SKILL.md'),
    reviewerSkill: path.join(skills, 'plan-fix-reviewer', 'SKILL.md'),
    reviewerSchema: path.join(skills, 'plan-fix-reviewer', 'review.schema.json'),
    translatorSkill: path.join(skills, 'plan-translator', 'SKILL.md'),
    markdownSchema: path.join(skills, '_shared', 'markdown.schema.json'),
    judgeSkill: path.join(skills, 'plan-judge', 'SKILL.md'),
    judgeSchema: path.join(skills, 'plan-judge', 'readiness.schema.json'),
  };
}

export interface ResumeState {
  startIter: number;
  archivedCount: number;
  archiveDir: string;
}

export interface PassOverrides {
  fixPass: PassKnobs;
  translatePass: PassKnobs;
}

export interface RunContext {
  work: string;
  mode: RunMode;
  inputPath: string;
  plansDir: string;
  config: ResolvedConfig;
  settings: RunSettings;
  quality: QualityMatrix;
  permissions: RolePermissions;
  skills: SkillPaths;
  provider: ProviderRuntime;
  passes: PassOverrides;
  maxPlanLines: number;
  split: SplitPolicy;
  lastCritiqueIter: number;
  resume: ResumeState;
}

// Command-substitution capture semantics: file content with trailing newlines
// stripped.
export function readStripped(file: string): string {
  return readFileSync(file, 'utf8').replace(/\n+$/, '');
}
