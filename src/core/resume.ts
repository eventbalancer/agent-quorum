import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

export type ResumeWorkdirResult =
  | { kind: 'resolved'; dir: string }
  | { kind: 'none' }
  | { kind: 'ambiguous' };

// Resolve the workdir an existing run lives in for --resume; guidance goes to
// stderr exactly like the reference (no [agent-quorum] prefix).
export function resolveResumeWorkdir(
  plansDir: string,
  base: string,
  quality = '',
): ResumeWorkdirResult {
  const candidates: string[] = [];
  if (quality !== '') {
    candidates.push(path.join(plansDir, `loop-${base}-${quality}`));
  }
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
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
      continue;
    }
    if (!existsSync(path.join(dir, 'run.meta.tsv')) && !existsSync(path.join(dir, 'plan.v0.md'))) {
      continue;
    }
    if (!existing.includes(dir)) {
      existing.push(dir);
    }
  }

  if (existing.length === 0) {
    process.stderr.write(`resume: no existing workdir with state for ${base} under ${plansDir}\n`);
    process.stderr.write(
      `  looked for loop-${base} and loop-${base}-<quality>; set AGENT_QUORUM_WORK_DIR to override\n`,
    );
    return { kind: 'none' };
  }
  if (existing.length > 1) {
    if (quality !== '') {
      const exact = path.join(plansDir, `loop-${base}-${quality}`);
      if (existing.includes(exact)) {
        return { kind: 'resolved', dir: exact };
      }
    }
    process.stderr.write(`resume: ambiguous workdir for ${base}; candidates:\n`);
    for (const dir of existing) {
      process.stderr.write(`  ${dir}\n`);
    }
    process.stderr.write('  set AGENT_QUORUM_WORK_DIR to the one you want to resume\n');
    return { kind: 'ambiguous' };
  }
  return { kind: 'resolved', dir: existing[0] ?? '' };
}
