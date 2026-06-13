import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileLineCount } from '../../runtime/files.js';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';
import type { JsonValue } from '../../core/json.js';

const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.pnpm-store',
]);

function isGeneratedName(name: string): boolean {
  return name.includes('.generated.');
}

// In-process workspace file snapshot reproducing the reference exclude set —
// hidden files included, the named directories excluded at any depth, and
// *.generated.* files dropped. Paths are PROJECT_ROOT-relative.
function snapshotWorkspaceFiles(projectRoot: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name)) {
          continue;
        }
        walk(path.join(dir, entry.name), entryRel);
      } else if (entry.isFile()) {
        if (isGeneratedName(entry.name)) {
          continue;
        }
        out.push(entryRel);
      }
    }
  };
  walk(projectRoot, '');
  return out;
}

// Emit only the code-bearing text of a plan: fenced-block bodies and inline
// `backtick` spans. Prose never reaches the reference miner.
export function extractPlanCodeSpans(planFile: string): string[] {
  const spans: string[] = [];
  let fence = false;
  for (const line of readFileSync(planFile, 'utf8').split('\n')) {
    if (line.startsWith('```')) {
      fence = !fence;
      continue;
    }
    if (fence) {
      spans.push(line);
      continue;
    }
    let rest = line;
    for (;;) {
      const match = /`[^`]+`/.exec(rest);
      if (!match) {
        break;
      }
      spans.push(match[0].slice(1, -1));
      rest = rest.slice(match.index + match[0].length);
    }
  }
  return spans;
}

interface Finding {
  readonly category: 'stale_line' | 'ambiguous' | 'unresolved';
  readonly file: string;
  readonly line: number;
  readonly candidates?: readonly string[];
  readonly actual_lines?: number;
}

export interface ReferenceCounters {
  direct: number;
  suffix: number;
  basename: number;
  ambiguous: number;
  unresolved: number;
  staleLine: number;
  glob: number;
  ambiguousSamples: string[];
  unresolvedSamples: string[];
  staleLineSamples: string[];
}

// The reference escapes only '.', '[' and '/' (sed 's|[.[/]|\\&|g'); other ERE
// metacharacters pass through, and an invalid pattern resolves to 0 matches.
function suffixPattern(file: string): RegExp | undefined {
  const escaped = file.replace(/[.[/]/g, '\\$&');
  try {
    return new RegExp(`(^|/)${escaped}$`);
  } catch {
    return undefined;
  }
}

function lineCountOf(file: string): number | undefined {
  try {
    return fileLineCount(file);
  } catch {
    return undefined;
  }
}

interface ResolvePlanReferencesResult {
  readonly counters: ReferenceCounters;
  readonly findings: readonly Finding[];
}

function resolvePlanReferences(
  projectRoot: string,
  planFile: string,
  wsFiles: readonly string[],
): ResolvePlanReferencesResult {
  const counters: ReferenceCounters = {
    direct: 0,
    suffix: 0,
    basename: 0,
    ambiguous: 0,
    unresolved: 0,
    staleLine: 0,
    glob: 0,
    ambiguousSamples: [],
    unresolvedSamples: [],
    staleLineSamples: [],
  };
  const findings: Finding[] = [];

  const spanText = extractPlanCodeSpans(planFile).join('\n');
  const refs = [...new Set(spanText.match(/[A-Za-z0-9_/.-]+\.[A-Za-z]{1,6}:[0-9]+/g) ?? [])].sort();

  for (const ref of refs) {
    const file = ref.slice(0, ref.lastIndexOf(':'));
    const line = Number.parseInt(ref.slice(ref.lastIndexOf(':') + 1), 10);

    if (file.includes('*') || file.includes('?')) {
      counters.glob += 1;
      continue;
    }

    let resolved: string;
    const directPath = path.join(projectRoot, file);
    if (existsSync(directPath) && statSync(directPath).isFile()) {
      resolved = file;
      counters.direct += 1;
    } else {
      const pattern = suffixPattern(file);
      const matches =
        pattern === undefined ? [] : wsFiles.filter((candidate) => pattern.test(candidate));
      if (matches.length === 1) {
        resolved = matches[0] ?? file;
        if (file.includes('/')) {
          counters.suffix += 1;
        } else {
          counters.basename += 1;
        }
      } else if (matches.length > 1) {
        counters.ambiguous += 1;
        counters.ambiguousSamples.push(`${file}:${line} (${matches.length} candidates)`);
        findings.push({ category: 'ambiguous', file, line, candidates: matches.slice(0, 10) });
        continue;
      } else {
        counters.unresolved += 1;
        counters.unresolvedSamples.push(`${file}:${line}`);
        findings.push({ category: 'unresolved', file, line });
        continue;
      }
    }

    const totalLines = lineCountOf(path.join(projectRoot, resolved));
    if (totalLines !== undefined && (line < 1 || line > totalLines)) {
      counters.staleLine += 1;
      counters.staleLineSamples.push(`${resolved}:${line} (has ${totalLines})`);
      findings.push({ category: 'stale_line', file: resolved, line, actual_lines: totalLines });
    }
  }

  return { counters, findings };
}

function aggregateFindings(findings: readonly Finding[], findingsFile: string): void {
  if (findings.length === 0) {
    writeFileSync(findingsFile, '{"stale_lines":[],"ambiguous":[],"unresolved":[]}\n');
    return;
  }
  const aggregated = {
    stale_lines: findings
      .filter((finding) => finding.category === 'stale_line')
      .map(({ file, line, actual_lines }) => ({ file, line, actual_lines })),
    ambiguous: findings
      .filter((finding) => finding.category === 'ambiguous')
      .map(({ file, line, candidates }) => ({ file, line, candidates })),
    unresolved: findings
      .filter((finding) => finding.category === 'unresolved')
      .map(({ file, line }) => ({ file, line })),
  };
  writeFileSync(findingsFile, `${JSON.stringify(aggregated, null, 2)}\n`);
}

function reportReferenceFindings(counters: ReferenceCounters): void {
  const total =
    counters.direct +
    counters.suffix +
    counters.basename +
    counters.ambiguous +
    counters.unresolved +
    counters.staleLine +
    counters.glob;
  log(`  file:line references: total=${total}`);
  if (counters.direct > 0) {
    log(`    resolved (direct):   ${counters.direct}`);
  }
  if (counters.suffix > 0) {
    log(`    resolved (suffix):   ${counters.suffix}`);
  }
  if (counters.basename > 0) {
    log(`    resolved (basename): ${counters.basename}`);
  }
  if (counters.glob > 0) {
    log(`    glob (skipped):      ${counters.glob}`);
  }
  if (counters.ambiguous > 0) {
    log(
      `    ambiguous basename:  ${counters.ambiguous} (e.g. ${counters.ambiguousSamples[0] ?? ''})`,
    );
  }
  if (counters.unresolved > 0) {
    log(
      `    unresolved:          ${counters.unresolved} (likely future files; e.g. ${counters.unresolvedSamples[0] ?? ''})`,
    );
  }
  if (counters.staleLine > 0) {
    for (const sample of counters.staleLineSamples) {
      err(`stale line: ${sample}`);
    }
    log(`WARNING: ${counters.staleLine} line-out-of-bounds references in plan.final.md`);
  }
}

// Shared by the final-plan scan and the package validator so both surfaces
// reject the same destructive commands. `git reset --hard` and `git checkout --`
// mirror the reference change-pack validator and the repo no-destructive-git rule.
export const FORBIDDEN_SHELL_STRINGS = [
  'pnpm -r',
  'pnpm --filter',
  'npx ',
  'git commit',
  'git push',
  'git pull',
  'git reset --hard',
  'git checkout --',
];

// The text of every fenced sh/bash/zsh/shell block in a markdown document,
// joined by newlines. Prose and non-shell fences never reach the forbidden scan.
export function extractShellBlockText(content: string): string {
  const blocks: string[] = [];
  let inBlock = false;
  for (const line of content.split('\n')) {
    if (/^```(sh|bash|zsh|shell)[ \t\v\f\r]*$/.test(line)) {
      inBlock = true;
      continue;
    }
    if (line.startsWith('```')) {
      inBlock = false;
      continue;
    }
    if (inBlock) {
      blocks.push(line);
    }
  }
  return blocks.join('\n');
}

function scanRuleViolations(planFile: string): number {
  const codeBlocks = extractShellBlockText(readFileSync(planFile, 'utf8'));

  let violations = 0;
  for (const forbidden of FORBIDDEN_SHELL_STRINGS) {
    if (codeBlocks.includes(forbidden)) {
      err(`RULE VIOLATION: plan shell block contains '${forbidden}'`);
      violations += 1;
    }
  }
  if (violations > 0) {
    err(`final validation FAILED: ${violations} workspace-rule violations`);
    return 5;
  }
  return 0;
}

export function validateFinalPlan(projectRoot: string, finalPlan: string): void {
  log('final validation pass');
  const findingsFile = path.join(path.dirname(finalPlan), 'findings.json');

  const wsFiles = snapshotWorkspaceFiles(projectRoot);
  const { counters, findings } = resolvePlanReferences(projectRoot, finalPlan, wsFiles);
  aggregateFindings(findings, findingsFile);
  reportReferenceFindings(counters);
  const ruleStatus = scanRuleViolations(finalPlan);
  if (ruleStatus !== 0) {
    throw new HaltError('workspace-rule violations in final plan', ruleStatus, true);
  }
}

export interface FindingsCounts {
  readonly stale: number;
  readonly ambiguous: number;
  readonly unresolved: number;
}

export const EMPTY_FINDINGS_COUNTS: FindingsCounts = {
  stale: 0,
  ambiguous: 0,
  unresolved: 0,
};

// Mine `file:line` references across a set of package documents and write the
// aggregated findings to `findingsFile` (kept separate from the final-plan
// `findings.json` so neither overwrites the other). Unlike `validateFinalPlan`
// this never throws on shell-rule violations — the package validator counts
// those separately via `FORBIDDEN_SHELL_STRINGS`.
export function validatePackageReferences(
  projectRoot: string,
  files: readonly string[],
  findingsFile: string,
): FindingsCounts {
  const workspaceFiles = snapshotWorkspaceFiles(projectRoot);
  const all: Finding[] = [];
  for (const file of files) {
    if (!existsSync(file)) {
      continue;
    }
    const { findings } = resolvePlanReferences(projectRoot, file, workspaceFiles);
    all.push(...findings);
  }
  aggregateFindings(all, findingsFile);
  return {
    stale: all.filter((finding) => finding.category === 'stale_line').length,
    ambiguous: all.filter((finding) => finding.category === 'ambiguous').length,
    unresolved: all.filter((finding) => finding.category === 'unresolved').length,
  };
}

export function readFindingsCounts(findingsFile: string): FindingsCounts {
  if (!existsSync(findingsFile)) {
    return EMPTY_FINDINGS_COUNTS;
  }
  try {
    const parsed = JSON.parse(readFileSync(findingsFile, 'utf8')) as JsonValue;
    const obj =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : {};
    const lengthOf = (value: JsonValue | undefined) => (Array.isArray(value) ? value.length : 0);
    return {
      stale: lengthOf(obj.stale_lines),
      ambiguous: lengthOf(obj.ambiguous),
      unresolved: lengthOf(obj.unresolved),
    };
  } catch {
    return EMPTY_FINDINGS_COUNTS;
  }
}
