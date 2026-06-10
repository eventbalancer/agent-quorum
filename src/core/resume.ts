import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import path from 'node:path';
import { HaltError } from '../runtime/halt.js';
import { err, log } from '../runtime/log.js';
import { artifactVersion } from './critic.js';
import { schemaValidQuiet } from './schema.js';
import type { ResumeState, RunContext } from './run-context.js';

function sortedMatches(work: string, prefix: string, suffix: string): string[] {
  let names: string[];
  try {
    names = readdirSync(work);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix))
    .sort()
    .map((name) => path.join(work, name));
}

// The last stable plan: the highest plan.vN.md whose update.v(N-1).json exists
// and validates against the creator schema (v0 is always stable).
export function lastStablePlan(work: string, creatorSchema: string): number {
  let best = -1;
  for (const file of sortedMatches(work, 'plan.v', '.md')) {
    const n = artifactVersion(file, 'plan.v', '.md');
    if (n === undefined) continue;
    if (n === 0) {
      if (n > best) best = n;
      continue;
    }
    const update = path.join(work, `update.v${n - 1}.json`);
    if (!nonEmptyFile(update)) continue;
    if (!schemaValidQuiet(update, creatorSchema)) continue;
    if (n > best) best = n;
  }
  if (best < 0) {
    const message = `resume failed: no stable plan.vN.md found in ${work}`;
    err(message);
    throw new HaltError(message, 4, true);
  }
  return best;
}

function stampForArchive(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function archiveResumeFile(work: string, state: ResumeState, file: string): void {
  if (!existsSync(file)) return;
  if (state.archiveDir === '') {
    state.archiveDir = path.join(work, `stale.${stampForArchive()}`);
    mkdirSync(state.archiveDir, { recursive: true });
  }
  renameSync(file, path.join(state.archiveDir, path.basename(file)));
  state.archivedCount += 1;
}

export function archiveResumeStale(work: string, state: ResumeState, start: number): void {
  const sweep = (prefix: string, suffix: string, keepUpTo: (n: number) => boolean) => {
    for (const file of sortedMatches(work, prefix, suffix)) {
      const n = artifactVersion(file, prefix, suffix);
      if (n === undefined) continue;
      if (!keepUpTo(n)) archiveResumeFile(work, state, file);
    }
  };
  sweep('critique.v', '.json', (n) => n < start);
  sweep('update.v', '.json', (n) => n < start);
  sweep('update-meta.v', '.json', (n) => n < start);
  sweep('plan.revision.v', '.md', (n) => n < start);
  sweep('plan.v', '.md', (n) => n <= start);
  for (const extra of [
    'plan.final.md',
    'summary.md',
    'findings.json',
    'fix-proposal.md',
    'fix-review.json',
    'fix-applied.md',
    'plan.final.before-fix.md',
  ]) {
    archiveResumeFile(work, state, path.join(work, extra));
  }
}

// The reference invokes prepare_resume inside a command substitution, so its
// RESUME_* variable writes never reach the parent shell: summary.md always
// reports resume_start=0 / archived=0. The port reproduces that quirk by
// keeping the archive state local and leaving ctx.resume untouched.
export function prepareResume(ctx: RunContext): number {
  const start = lastStablePlan(ctx.work, ctx.skills.creatorSchema);
  const state: ResumeState = { startIter: start, archivedCount: 0, archiveDir: '' };
  archiveResumeStale(ctx.work, state, start);
  if (state.archivedCount > 0) {
    log(`resume archived ${state.archivedCount} stale artifact(s) to ${state.archiveDir}`);
  } else {
    log('resume found no stale artifacts');
  }
  return start;
}

export type ResumeWorkdirResult =
  | { kind: 'resolved'; dir: string }
  | { kind: 'none' }
  | { kind: 'ambiguous' };

// Resolve the workdir an existing run lives in for --resume; guidance goes to
// stderr exactly like the reference (no [plan-loop] prefix).
export function resolveResumeWorkdir(
  plansDir: string,
  base: string,
  effort = '',
): ResumeWorkdirResult {
  const candidates: string[] = [];
  if (effort !== '') candidates.push(path.join(plansDir, `loop-${base}-${effort}`));
  candidates.push(path.join(plansDir, `loop-${base}`));
  try {
    candidates.push(
      ...readdirSync(plansDir)
        .filter((name) => name.startsWith(`loop-${base}-`))
        .sort()
        .map((name) => path.join(plansDir, name)),
    );
  } catch {
    /* plans dir missing — no glob candidates */
  }

  const existing: string[] = [];
  for (const dir of candidates) {
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;
    if (!existsSync(path.join(dir, 'run.meta.tsv')) && !existsSync(path.join(dir, 'plan.v0.md'))) {
      continue;
    }
    if (!existing.includes(dir)) existing.push(dir);
  }

  if (existing.length === 0) {
    process.stderr.write(`resume: no existing workdir with state for ${base} under ${plansDir}\n`);
    process.stderr.write(
      `  looked for loop-${base} and loop-${base}-<effort>; set PLAN_LOOP_WORK_DIR to override\n`,
    );
    return { kind: 'none' };
  }
  if (existing.length > 1) {
    if (effort !== '') {
      const exact = path.join(plansDir, `loop-${base}-${effort}`);
      if (existing.includes(exact)) return { kind: 'resolved', dir: exact };
    }
    process.stderr.write(`resume: ambiguous workdir for ${base}; candidates:\n`);
    for (const dir of existing) process.stderr.write(`  ${dir}\n`);
    process.stderr.write('  set PLAN_LOOP_WORK_DIR to the one you want to resume\n');
    return { kind: 'ambiguous' };
  }
  return { kind: 'resolved', dir: existing[0] ?? '' };
}
