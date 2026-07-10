import { existsSync, mkdirSync, readdirSync, renameSync } from 'node:fs';
import path from 'node:path';
import { nonEmptyFile } from '../../runtime/files.js';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';
import { artifactVersion } from './critic.js';
import { schemaValidQuiet } from '../../core/schema.js';
import type { ResumeState, RunContext } from '../../core/run-context.js';

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
    if (n === undefined) {
      continue;
    }
    if (n === 0) {
      best = Math.max(best, 0);
      continue;
    }
    const update = path.join(work, `update.v${n - 1}.json`);
    if (!nonEmptyFile(update)) {
      continue;
    }
    if (!schemaValidQuiet(update, creatorSchema)) {
      continue;
    }
    if (n > best) {
      best = n;
    }
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
  if (!existsSync(file)) {
    return;
  }
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
      if (n === undefined) {
        continue;
      }
      if (!keepUpTo(n)) {
        archiveResumeFile(work, state, file);
      }
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
    'plan.split.json',
    'package-findings.json',
    'plan.package',
    'judge.final.raw',
    'judge.final.json',
    'judge.final.meta.json',
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
