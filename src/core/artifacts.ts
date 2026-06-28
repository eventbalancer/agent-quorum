import { renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export interface RunMetadataRole {
  runner: string;
  model: string;
  reasoning: string;
}

export interface RunMetadataSingleToolsRole extends RunMetadataRole {
  tools: string;
  disallowedTools: string;
}

export interface RunMetadataCreatorRole extends RunMetadataRole {
  createTools: string;
  createDisallowedTools: string;
  updateTools: string;
  updateDisallowedTools: string;
}

export interface RunMetadata {
  pid: number;
  pgid: string;
  mode: string;
  inputPath: string;
  workDir: string;
  plansDir: string;
  startedAt: string;
  quality: string;
  sessionMode: string;
  creatorOneShot: string;
  previousCritiques: string;
  topology: string;
  maxIters: number;
  fixPass: string;
  diffThreshold: number;
  creator: RunMetadataCreatorRole;
  critic: RunMetadataSingleToolsRole;
  fixer: RunMetadataSingleToolsRole;
  reviewer: RunMetadataSingleToolsRole;
  judge: RunMetadataSingleToolsRole;
  runId: string;
  name: string;
}

// Role rows follow the execution sequence (creator, critic, fixer, reviewer, judge;
// translator is omitted here); run_id and name are appended as trailing rows.
export function renderRunMetadata(meta: RunMetadata): string {
  const rows: [string, string][] = [
    ['pid', String(meta.pid)],
    ['pgid', meta.pgid],
    ['mode', meta.mode],
    ['input_path', meta.inputPath],
    ['work_dir', meta.workDir],
    ['plans_dir', meta.plansDir],
    ['log_path', path.join(meta.workDir, 'run.log')],
    ['interventions_path', path.join(meta.workDir, 'operator-interventions.jsonl')],
    ['started_at', meta.startedAt],
    ['quality', meta.quality],
    ['session_mode', meta.sessionMode],
    ['creator_one_shot', meta.creatorOneShot],
    ['previous_critiques', meta.previousCritiques],
    ['topology', meta.topology],
    ['max_iters', String(meta.maxIters)],
    ['fix_pass', meta.fixPass],
    ['diff_threshold', String(meta.diffThreshold)],
    ['creator_runner', meta.creator.runner],
    ['creator_model', meta.creator.model],
    ['creator_reasoning', meta.creator.reasoning],
    ['creator_create_tools', meta.creator.createTools],
    ['creator_create_disallowed_tools', meta.creator.createDisallowedTools],
    ['creator_update_tools', meta.creator.updateTools],
    ['creator_update_disallowed_tools', meta.creator.updateDisallowedTools],
    ['critic_runner', meta.critic.runner],
    ['critic_model', meta.critic.model],
    ['critic_reasoning', meta.critic.reasoning],
    ['critic_tools', meta.critic.tools],
    ['critic_disallowed_tools', meta.critic.disallowedTools],
    ['fixer_runner', meta.fixer.runner],
    ['fixer_model', meta.fixer.model],
    ['fixer_reasoning', meta.fixer.reasoning],
    ['fixer_tools', meta.fixer.tools],
    ['fixer_disallowed_tools', meta.fixer.disallowedTools],
    ['reviewer_runner', meta.reviewer.runner],
    ['reviewer_model', meta.reviewer.model],
    ['reviewer_reasoning', meta.reviewer.reasoning],
    ['reviewer_tools', meta.reviewer.tools],
    ['reviewer_disallowed_tools', meta.reviewer.disallowedTools],
    ['judge_runner', meta.judge.runner],
    ['judge_model', meta.judge.model],
    ['judge_reasoning', meta.judge.reasoning],
    ['judge_tools', meta.judge.tools],
    ['judge_disallowed_tools', meta.judge.disallowedTools],
    ['run_id', meta.runId],
    ['name', meta.name],
  ];
  return rows.map(([key, value]) => `${key}\t${value}\n`).join('');
}

function writeRunMetadataFile(target: string, meta: RunMetadata): void {
  const tmp = `${target}.${meta.pid}`;
  writeFileSync(tmp, renderRunMetadata(meta));
  renameSync(tmp, target);
}

export function writeRunMetadata(
  runMetaFile: string,
  runRegistryFile: string,
  meta: RunMetadata,
): void {
  writeRunMetadataFile(runMetaFile, meta);
  writeRunMetadataFile(runRegistryFile, meta);
}

export function cleanupRunRegistry(runRegistryFile: string): void {
  try {
    rmSync(runRegistryFile, { force: true });
  } catch {
    /* best effort */
  }
}

export function nowUtcStamp(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}
