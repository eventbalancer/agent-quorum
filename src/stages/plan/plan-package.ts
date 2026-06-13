import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { countNewlines } from '../../runtime/files.js';
import { planHasHeading, planHasImpactGraphMermaid } from './plan-shape.js';
import {
  extractShellBlockText,
  EMPTY_FINDINGS_COUNTS,
  FORBIDDEN_SHELL_STRINGS,
  validatePackageReferences,
  type FindingsCounts,
} from './validate-plan.js';
import type { SplitMode } from '../../core/split-policy.js';

export type { SplitMode } from '../../core/split-policy.js';

// Default structural-complexity threshold: a plan with this many Work Plan
// phases splits under `auto` even when it stays within the size signal.
export const DEFAULT_SPLIT_MIN_PHASES = 5;

export const PACKAGE_DIR_NAME = 'plan.package';
export const SPLIT_DECISION_FILE = 'plan.split.json';
export const PACKAGE_FINDINGS_FILE = 'package-findings.json';

export const REQUIRED_PACKAGE_FILES = [
  'README.md',
  'plan.md',
  'run.md',
  'journal.md',
  'remaining-debt.md',
] as const;

const PLAN_MD_REQUIRED_HEADINGS = [
  'Context',
  'Verified Facts',
  'Target State',
  'Scope',
  'Work Plan',
  'Files and Interfaces',
  'Verification',
  'STOP Triggers',
  'Impact Graph',
] as const;

export const JOURNAL_REQUIRED_HEADINGS = [
  'Current State',
  'Progress',
  'Acceptance Gates',
  'Issues / Workarounds',
  'Plan Deltas',
  'Stop / Report Log',
  'Restart Checklist',
] as const;

export const RUNBOOK_REQUIRED_HEADINGS = [
  'Arguments',
  'Step 0 - Position',
  'Step 1 - Preflight',
  'Step 2 - Execute One Phase Pin',
  'Step 3 - After Execution',
  'Hard Rules',
  'Self-monitoring',
  'Stop Report Format',
] as const;

export const PHASE_REQUIRED_HEADINGS = [
  'Goal',
  'Pre-requisites',
  'Phase Pins',
  'Preflight',
  'Steps',
  'Verification',
  'Acceptance Gate',
  'Common Pitfalls',
  'Stop Conditions',
] as const;

const README_TARGET_LINES = 150;
const PHASE_TARGET_LINES = 350;

export interface PlanPhase {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
  readonly touches: string;
  readonly dependsOn: string;
  readonly acceptanceGate: string;
  readonly detail: readonly string[];
  readonly verification: readonly string[];
}

export interface PlanStructure {
  readonly title: string;
  readonly lineCount: number;
  readonly workPlanPresent: boolean;
  readonly phases: readonly PlanPhase[];
  readonly filesAndInterfaces: readonly string[];
  readonly verification: readonly string[];
  readonly stopTriggers: readonly string[];
  readonly nonGoals: readonly string[];
  readonly openQuestions: readonly string[];
  readonly hasSchemaImpact: boolean;
  readonly hasApiImpact: boolean;
  readonly hasCrossRepoImpact: boolean;
}

export interface SplitSignals {
  readonly planLines: number;
  readonly maxPlanLines: number;
  readonly phaseCount: number;
  readonly minPhases: number;
  readonly touchedSurfaceCount: number;
  readonly verificationCount: number;
  readonly stopTriggerCount: number;
  readonly schemaImpact: boolean;
  readonly apiImpact: boolean;
  readonly crossRepoImpact: boolean;
}

export interface SplitDecision {
  readonly split: boolean;
  readonly rationale: string;
  readonly signals: SplitSignals;
}

export interface SplitDecisionKnobs {
  readonly mode: SplitMode;
  readonly minPhases: number;
  readonly maxPlanLines: number;
}

export interface PackagePaths {
  readonly dir: string;
  readonly readme: string;
  readonly plan: string;
  readonly run: string;
  readonly journal: string;
  readonly remainingDebt: string;
  readonly phases: readonly string[];
}

export type EmitPlanPackageResult =
  | { readonly kind: 'emitted'; readonly paths: PackagePaths }
  | { readonly kind: 'empty-work-plan' };

export interface PackageHealth {
  readonly ok: boolean;
  readonly emptyWorkPlan: boolean;
  readonly missingFiles: number;
  readonly missingHeadings: number;
  readonly brokenCrossRefs: number;
  readonly forbiddenShell: number;
  readonly references: FindingsCounts;
}

export interface ValidatePlanPackageOptions {
  readonly findingsFile?: string;
}

export function resolveSplitMode(value: string | undefined): SplitMode {
  switch (value) {
    case 'always':
    case 'never':
    case 'auto':
      return value;
    default:
      return 'auto';
  }
}

interface DocSection {
  readonly heading: string;
  readonly lines: string[];
}

interface SplitDocumentResult {
  readonly title: string;
  readonly sections: readonly DocSection[];
}

function splitDocument(content: string): SplitDocumentResult {
  let title = '';
  const sections: DocSection[] = [];
  let current: DocSection | undefined;
  let fence = false;
  for (const line of content.split('\n')) {
    if (line.startsWith('```')) {
      fence = !fence;
      if (current !== undefined) {
        current.lines.push(line);
      }
      continue;
    }
    if (!fence) {
      const h2 = /^##\s+(.+?)\s*$/.exec(line);
      if (h2) {
        current = { heading: (h2[1] ?? '').trim(), lines: [] };
        sections.push(current);
        continue;
      }
      const h1 = /^#\s+(.+?)\s*$/.exec(line);
      if (h1 && title === '' && current === undefined) {
        title = (h1[1] ?? '').trim();
        continue;
      }
    }
    if (current !== undefined) {
      current.lines.push(line);
    }
  }
  return { title, sections };
}

function headingMatches(heading: string, name: string): boolean {
  if (heading === name) {
    return true;
  }
  if (!heading.startsWith(name)) {
    return false;
  }
  const next = heading.charAt(name.length);
  return next === ' ' || next === '(' || next === ':' || next === '-';
}

function getSection(sections: readonly DocSection[], name: string): string[] {
  const found = sections.find((section) => headingMatches(section.heading, name));
  return found ? found.lines : [];
}

function bulletLines(lines: readonly string[]): string[] {
  return lines
    .map((line) => line.trim())
    .filter(
      (line) =>
        /^([-*]\s+|\d+\.\s+)/.test(line) ||
        (line.startsWith('|') && !isSeparatorRow(parseTableRow(line))),
    );
}

function parseTableRow(line: string): string[] {
  const trimmed = line.trim();
  if (!trimmed.startsWith('|')) {
    return [];
  }
  const cells = trimmed.split('|').map((cell) => cell.trim());
  if (cells.length > 0 && cells[0] === '') {
    cells.shift();
  }
  if (cells.length > 0 && cells[cells.length - 1] === '') {
    cells.pop();
  }
  return cells;
}

function isSeparatorRow(cells: readonly string[]): boolean {
  return cells.length > 0 && cells.every((cell) => /^:?-+:?$/.test(cell));
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const trimmed = slug.split('-').filter(Boolean).slice(0, 6).join('-');
  return trimmed === '' ? 'phase' : trimmed;
}

function cleanName(name: string): string {
  return name
    .replace(/^[—–-]\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function trimBlankEdges(lines: readonly string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && (out[0] ?? '').trim() === '') {
    out.shift();
  }
  while (out.length > 0 && (out[out.length - 1] ?? '').trim() === '') {
    out.pop();
  }
  return out;
}

function crossRefBullets(lines: readonly string[], id: string): string[] {
  const pattern = new RegExp(`^[-*]\\s*\\*{0,2}${id}\\b`);
  return lines.map((line) => line.trim()).filter((line) => pattern.test(line));
}

function extractSubsections(lines: readonly string[]): Map<string, string[]> {
  const byId = new Map<string, string[]>();
  let currentId: string | undefined;
  let body: string[] = [];
  let fence = false;
  const flush = () => {
    if (currentId !== undefined) {
      byId.set(currentId, trimBlankEdges(body));
    }
    body = [];
  };
  for (const line of lines) {
    if (line.startsWith('```')) {
      fence = !fence;
      if (currentId !== undefined) {
        body.push(line);
      }
      continue;
    }
    const h3 = !fence ? /^###\s+(.+)$/.exec(line) : null;
    if (h3) {
      flush();
      const idMatch = /\bP\d+\b/.exec(h3[1] ?? '');
      currentId = idMatch ? idMatch[0] : undefined;
      continue;
    }
    if (currentId !== undefined) {
      body.push(line);
    }
  }
  flush();
  return byId;
}

interface TablePhase {
  readonly id: string;
  readonly name: string;
  readonly touches: string;
  readonly dependsOn: string;
  readonly acceptanceGate: string;
}

interface PhaseTableHeader {
  readonly phase: number;
  readonly touches: number;
  readonly depends: number;
  readonly gate: number;
}

function parsePhaseTable(lines: readonly string[]): TablePhase[] {
  const result: TablePhase[] = [];
  let header: PhaseTableHeader | undefined;
  let auto = 0;
  let started = false;
  for (const line of lines) {
    const cells = parseTableRow(line);
    if (cells.length === 0) {
      if (started) {
        break;
      }
      continue;
    }
    if (isSeparatorRow(cells)) {
      continue;
    }
    if (header === undefined) {
      const lower = cells.map((cell) => cell.toLowerCase());
      const phaseIdx = lower.findIndex((cell) => cell.startsWith('phase'));
      const touchesIdx = lower.findIndex((cell) => cell.includes('touch'));
      if (phaseIdx >= 0 && touchesIdx >= 0) {
        header = {
          phase: phaseIdx,
          touches: touchesIdx,
          depends: lower.findIndex((cell) => cell.includes('depend')),
          gate: lower.findIndex((cell) => cell.includes('acceptance') || cell.includes('gate')),
        };
        started = true;
      }
      continue;
    }
    auto += 1;
    const phaseCell = cells[header.phase] ?? '';
    const idMatch = /\bP\d+\b/.exec(phaseCell);
    const id = idMatch ? idMatch[0] : `P${String(auto)}`;
    const name = cleanName(idMatch ? phaseCell.replace(idMatch[0], '') : phaseCell);
    result.push({
      id,
      name: name === '' ? id : name,
      touches: header.touches >= 0 ? (cells[header.touches] ?? '').trim() : '',
      dependsOn: header.depends >= 0 ? (cells[header.depends] ?? '').trim() : '',
      acceptanceGate: header.gate >= 0 ? (cells[header.gate] ?? '').trim() : '',
    });
  }
  return result;
}

interface NumberedItem {
  readonly name: string;
  readonly detail: string[];
}

function parseNumberedList(lines: readonly string[]): NumberedItem[] {
  const items: NumberedItem[] = [];
  let current: NumberedItem | undefined;
  let fence = false;
  for (const line of lines) {
    if (line.startsWith('```')) {
      fence = !fence;
      if (current !== undefined) {
        current.detail.push(line);
      }
      continue;
    }
    const match = !fence ? /^\d+\.\s+(.*)$/.exec(line) : null;
    if (match) {
      current = { name: (match[1] ?? '').trim(), detail: [line] };
      items.push(current);
      continue;
    }
    if (current !== undefined) {
      current.detail.push(line);
    }
  }
  return items;
}

function buildPhase(
  spec: TablePhase,
  detail: readonly string[],
  sections: readonly DocSection[],
): PlanPhase {
  const name = cleanName(spec.name);
  return {
    id: spec.id,
    name: name === '' ? spec.id : name,
    slug: slugify(name === '' ? spec.id : name),
    touches: spec.touches,
    dependsOn: spec.dependsOn,
    acceptanceGate: spec.acceptanceGate,
    detail: trimBlankEdges(detail),
    verification: crossRefBullets(getSection(sections, 'Verification'), spec.id),
  };
}

function extractPhases(
  workPlanLines: readonly string[],
  title: string,
  sections: readonly DocSection[],
): PlanPhase[] {
  const subsections = extractSubsections(workPlanLines);
  const table = parsePhaseTable(workPlanLines);
  if (table.length > 0) {
    return table.map((entry) => buildPhase(entry, subsections.get(entry.id) ?? [], sections));
  }
  const numbered = parseNumberedList(workPlanLines);
  if (numbered.length > 0) {
    return numbered.map((item, index) =>
      buildPhase(
        {
          id: `P${String(index + 1)}`,
          name: item.name,
          touches: '',
          dependsOn: '',
          acceptanceGate: '',
        },
        item.detail,
        sections,
      ),
    );
  }
  if (workPlanLines.some((line) => line.trim() !== '')) {
    return [
      buildPhase(
        {
          id: 'P1',
          name: title === '' ? 'Work Plan' : title,
          touches: '',
          dependsOn: '',
          acceptanceGate: '',
        },
        workPlanLines,
        sections,
      ),
    ];
  }
  return [];
}

function extractNonGoals(scopeLines: readonly string[]): string[] {
  const out: string[] = [];
  let collecting = false;
  for (const raw of scopeLines) {
    const line = raw.trim();
    if (
      /non-?goal|out[ -]of[ -]scope/i.test(line) &&
      !line.startsWith('-') &&
      !line.startsWith('*')
    ) {
      collecting = true;
      continue;
    }
    if (collecting && /^[-*]\s+/.test(line)) {
      out.push(line);
    }
  }
  return out;
}

export function parsePlanStructure(planFile: string): PlanStructure {
  const content = readFileSync(planFile, 'utf8');
  const { title, sections } = splitDocument(content);
  const workPlan = getSection(sections, 'Work Plan');
  const lower = content.toLowerCase();
  return {
    title: title === '' ? path.basename(planFile, '.md') : title,
    lineCount: countNewlines(content),
    workPlanPresent: workPlan.some((line) => line.trim() !== ''),
    phases: extractPhases(workPlan, title, sections),
    filesAndInterfaces: bulletLines(getSection(sections, 'Files and Interfaces')),
    verification: bulletLines(getSection(sections, 'Verification')),
    stopTriggers: bulletLines(getSection(sections, 'STOP Triggers')),
    nonGoals: extractNonGoals(getSection(sections, 'Scope')),
    openQuestions: bulletLines(getSection(sections, 'Open Questions')),
    hasSchemaImpact: lower.includes('.schema.json') || /\bschema(s)?\b/.test(lower),
    hasApiImpact:
      lower.includes('public api') || lower.includes('runresult') || lower.includes('src/index.ts'),
    hasCrossRepoImpact:
      lower.includes('cross-repo') || lower.includes('cross repo') || lower.includes('multi-repo'),
  };
}

export function evaluateSplitDecision(
  structure: PlanStructure,
  knobs: SplitDecisionKnobs,
): SplitDecision {
  const signals: SplitSignals = {
    planLines: structure.lineCount,
    maxPlanLines: knobs.maxPlanLines,
    phaseCount: structure.phases.length,
    minPhases: knobs.minPhases,
    touchedSurfaceCount: structure.filesAndInterfaces.length,
    verificationCount: structure.verification.length,
    stopTriggerCount: structure.stopTriggers.length,
    schemaImpact: structure.hasSchemaImpact,
    apiImpact: structure.hasApiImpact,
    crossRepoImpact: structure.hasCrossRepoImpact,
  };
  const overSize = signals.planLines > knobs.maxPlanLines;
  const structurallyComplex = signals.phaseCount >= knobs.minPhases;
  switch (knobs.mode) {
    case 'always': {
      return {
        split: true,
        rationale: `AGENT_QUORUM_SPLIT=always: package emitted regardless of size (${String(signals.planLines)} lines, ${String(signals.phaseCount)} phases)`,
        signals,
      };
    }
    case 'never': {
      const rationale = overSize
        ? `AGENT_QUORUM_SPLIT=never: ${String(signals.planLines)} lines exceeds the ${String(knobs.maxPlanLines)}-line size signal but single-document output is forced by override`
        : `AGENT_QUORUM_SPLIT=never: single-document output forced by override (${String(signals.planLines)} lines)`;
      return { split: false, rationale, signals };
    }
    case 'auto': {
      if (overSize || structurallyComplex) {
        const reasons: string[] = [];
        if (overSize) {
          reasons.push(
            `${String(signals.planLines)} lines over the ${String(knobs.maxPlanLines)}-line size signal`,
          );
        }
        if (structurallyComplex) {
          reasons.push(
            `${String(signals.phaseCount)} phases at or above the ${String(knobs.minPhases)}-phase threshold`,
          );
        }
        return { split: true, rationale: `auto split: ${reasons.join('; ')}`, signals };
      }
      return {
        split: false,
        rationale: `auto: ${String(signals.planLines)} lines within the ${String(knobs.maxPlanLines)}-line size signal and ${String(signals.phaseCount)} phases below the ${String(knobs.minPhases)}-phase threshold; single-document output`,
        signals,
      };
    }
    default: {
      knobs.mode satisfies never;
      throw new Error('unreachable split mode');
    }
  }
}

function withOversizeNote(content: string, target: number, label: string): string {
  const lines = countNewlines(content);
  if (lines <= target) {
    return content;
  }
  return `${content}\n> Oversize: ${label} is ${String(lines)} lines, over the ${String(target)}-line target; kept whole to preserve execution detail (no truncation).\n`;
}

function renderPhaseDoc(phase: PlanPhase, phases: readonly PlanPhase[], index: number): string {
  const prev = index > 0 ? phases[index - 1] : undefined;
  const steps =
    phase.detail.length > 0
      ? phase.detail
      : [`1. Implement ${phase.name} as specified for ${phase.id} in \`plan.md\`.`];
  const verification =
    phase.verification.length > 0
      ? phase.verification
      : ['- Run the checks that gate this phase and confirm the acceptance gate below.'];
  const out = [
    `# Phase ${phase.id} - ${phase.name}`,
    '',
    'This phase document is self-contained: goal, touch surfaces, steps, and acceptance gate are included so it can be executed on its own.',
    '',
    '## Goal',
    '',
    `- Deliver ${phase.name}.`,
    ...(phase.acceptanceGate !== '' ? [`- Done when: ${phase.acceptanceGate}`] : []),
    '',
    '## Pre-requisites',
    '',
    prev !== undefined
      ? `- [ ] Phase ${prev.id} (${prev.name}) is complete and its acceptance gate is met.`
      : '- [ ] Baseline checks are green or explicitly documented in `journal.md`.',
    ...(phase.dependsOn !== '' && phase.dependsOn !== '-'
      ? [`- [ ] Dependencies satisfied: ${phase.dependsOn}.`]
      : []),
    '- [ ] `journal.md` current state matches the repository state.',
    '',
    '## Phase Pins',
    '',
    '| ID | Action | Touches | Acceptance |',
    '| --- | --- | --- | --- |',
    `| ${phase.id} | ${phase.name} | ${phase.touches !== '' ? phase.touches : 'see `plan.md` Files and Interfaces'} | ${phase.acceptanceGate !== '' ? phase.acceptanceGate : 'phase acceptance gate below'} |`,
    '',
    '## Preflight',
    '',
    'Run before editing:',
    '',
    '```bash',
    'pnpm run typecheck',
    '```',
    '',
    'Add narrower checks when this phase touches schemas, providers, the CLI, the public API, or generated artifacts.',
    '',
    '## Steps',
    '',
    ...steps,
    '',
    '## Verification',
    '',
    ...verification,
    '',
    '```bash',
    'pnpm run check',
    '```',
    '',
    '## Acceptance Gate',
    '',
    `- [ ] ${phase.acceptanceGate !== '' ? phase.acceptanceGate : `${phase.name} is complete and verified.`}`,
    `- [ ] \`journal.md\` records progress and notes for ${phase.id}.`,
    '- [ ] No unrelated files are included.',
    '',
    '## Common Pitfalls',
    '',
    `- Do not widen scope beyond ${phase.id}.`,
    '- Do not edit generated artifacts (`dist/`, `coverage/`, lockfiles) by hand.',
    '- Do not introduce destructive git or non-`pnpm` package commands.',
    '',
    '## Stop Conditions',
    '',
    '- Stop and write a stop report in `journal.md` (format in `run.md`) if a file, symbol, or interface named here is absent or materially different.',
    '- Stop if the same check fails three times or edits start cycling.',
    '',
  ].join('\n');
  return withOversizeNote(out, PHASE_TARGET_LINES, `phase-${phase.id}`);
}

function phaseLabelNumber(phase: PlanPhase, index: number): string {
  const match = /\d+/.exec(phase.id);
  return match ? match[0] : String(index + 1);
}

function phaseFileName(phase: PlanPhase, index: number): string {
  return `phase-${phaseLabelNumber(phase, index)}-${phase.slug}.md`;
}

// Filenames carry the phase label number (P0 -> phase-0-...) so they round-trip
// with `phaseIdFromFile`; two phases sharing a label number and slug would
// otherwise collide and silently overwrite, so disambiguate to keep every doc.
function phaseFileNames(phases: readonly PlanPhase[]): string[] {
  const used = new Set<string>();
  return phases.map((phase, index) => {
    let name = phaseFileName(phase, index);
    let suffix = 2;
    while (used.has(name)) {
      name = name.replace(/\.md$/, `-${String(suffix)}.md`);
      suffix += 1;
    }
    used.add(name);
    return name;
  });
}

function renderReadme(
  structure: PlanStructure,
  phases: readonly PlanPhase[],
  decision: SplitDecision,
  phaseNames: readonly string[],
): string {
  const routeRows = phases.map(
    (phase, index) =>
      `| ${phase.id} | \`${phaseNames[index] ?? phaseFileName(phase, index)}\` | ${phase.id} | ${phase.acceptanceGate !== '' ? phase.acceptanceGate : 'see phase doc'} |`,
  );
  const out = [
    `# ${structure.title} - change pack`,
    '',
    'This directory is the execution pack for the plan above. `plan.md` is the authoritative master plan (a byte-for-byte copy of `plan.final.md`); the phase docs slice it into executable units.',
    '',
    '## Bootstrap Order',
    '',
    'Read these files in order at the start of every new session:',
    '',
    '1. `README.md` - map, contract, and current route.',
    '2. `journal.md` - current state, progress, plan deltas, and stop log.',
    '3. `run.md` - execution protocol for one phase pin.',
    '4. The current `phase-*.md` file selected from `journal.md`.',
    '5. `plan.md` only by direct section reference from the phase file.',
    '',
    'Phase docs carry enough context to implement one phase; consult `plan.md` only by direct section reference.',
    '',
    '## Document Map',
    '',
    '| File | Role | When to read |',
    '| --- | --- | --- |',
    '| `README.md` | Pack map and bootstrap contract | First in every session |',
    '| `plan.md` | Authoritative master plan and source of truth | By direct section reference |',
    '| `journal.md` | Progress, blockers, deltas, restart context | Before and after each phase pin |',
    '| `run.md` | Execution protocol | Before touching files |',
    '| `phase-*.md` | Executable phase slices | One current phase at a time |',
    '| `remaining-debt.md` | Conscious non-scope and follow-up ledger | Before final review |',
    '',
    '## Route',
    '',
    '| Phase | File | Pins | Gate |',
    '| --- | --- | --- | --- |',
    ...routeRows,
    '',
    '## Split Rationale',
    '',
    `- ${decision.rationale}`,
    `- Signals: ${String(decision.signals.planLines)} lines, ${String(decision.signals.phaseCount)} phases, ${String(decision.signals.touchedSurfaceCount)} touched surfaces.`,
    '',
    '## Contract',
    '',
    '- Use repository entry points: `pnpm run <script>` and `pnpm exec <bin>`; never `npx`.',
    '- Do not commit or push unless the operator explicitly asks.',
    '- Execute one phase pin at a time and keep scope limited to the current phase file.',
    '- Update `journal.md` whenever reality diverges from the plan.',
    '',
  ].join('\n');
  return withOversizeNote(out, README_TARGET_LINES, 'README.md');
}

function renderJournal(structure: PlanStructure): string {
  const phases = structure.phases;
  const first = phases[0];
  const second = phases[1];
  const progressRows = phases.map(
    (phase, index) =>
      `| ${String(index + 1)} | ${phase.id} | ${phase.id} | pending | ${phase.name} |`,
  );
  const gateRows = phases.map(
    (phase) =>
      `- [ ] ${phase.id}: ${phase.acceptanceGate !== '' ? phase.acceptanceGate : `${phase.name} complete and verified.`}`,
  );
  return [
    `# ${structure.title} - journal`,
    '',
    'This file is the single source of truth for execution state. Keep it short enough to read at the start of every session.',
    '',
    '## Current State',
    '',
    '- Branch: `<branch or not created>`.',
    '- Baseline: `<repo>@<sha or not recorded>`.',
    '- Last completed phase: `none`.',
    `- Current phase in progress: \`${first?.id ?? 'P1'}\`.`,
    `- Next step: execute \`${first?.id ?? 'P1'}\` (then \`${second?.id ?? 'done'}\`).`,
    '',
    '## Progress',
    '',
    '| # | Phase | Pin | Status | Notes |',
    '| --- | --- | --- | --- | --- |',
    ...progressRows,
    '',
    'Status values: `pending`, `in_progress`, `done`, `blocked`, `skipped`. The first `pending` row is the current phase; the next row is the next phase.',
    '',
    '## Acceptance Gates',
    '',
    ...gateRows,
    '',
    '## Issues / Workarounds',
    '',
    '| Date | Pin | Issue | Decision |',
    '| --- | --- | --- | --- |',
    '| - | - | - | - |',
    '',
    '## Plan Deltas',
    '',
    'Record only real divergence between the plan and current workspace reality.',
    '',
    '| Date | Source | Delta | Resolution |',
    '| --- | --- | --- | --- |',
    '| - | - | - | - |',
    '',
    '## Stop / Report Log',
    '',
    'Use the stop report format from `run.md` when execution halts.',
    '',
    '## Restart Checklist',
    '',
    '1. Read `README.md`.',
    '2. Read this `journal.md`.',
    '3. Read `run.md`.',
    '4. Open the current `phase-*.md` selected by the first pending progress row.',
    '5. Verify current workspace state with read-only commands before editing.',
    '6. Run the phase preflight checks.',
    '7. Execute only the next pending phase pin.',
    '',
  ].join('\n');
}

function renderRunbook(title: string): string {
  return [
    `# ${title} - runbook`,
    '',
    'This runbook is the execution protocol for the change pack. It is independent of any planning loop or model runner.',
    '',
    '## Arguments',
    '',
    '```text',
    'run                select the next pending phase pin from journal.md',
    'run <override>     use an operator-provided starting point or constraint',
    '```',
    '',
    '## Step 0 - Position',
    '',
    'Before editing files:',
    '',
    '1. Read `README.md`.',
    '2. Read `journal.md`.',
    '3. Read this `run.md`.',
    '4. Read the current `phase-*.md`.',
    '5. Check the relevant repository state with read-only commands.',
    '6. Compare the current state with `journal.md`.',
    '',
    'If an override is provided, state what automatic positioning would have selected and why the override wins.',
    '',
    '## Step 1 - Preflight',
    '',
    'For the current phase:',
    '',
    '1. Confirm all prerequisites in the phase file.',
    '2. Confirm workspace rules from `AGENTS.md` / `CLAUDE.md`.',
    '3. Run the phase preflight checks.',
    '4. If any preflight check fails, stop and write a stop report in `journal.md`.',
    '',
    '## Step 2 - Execute One Phase Pin',
    '',
    'Execute exactly one pending phase pin:',
    '',
    '1. Implement only the files and behavior named in the phase pin.',
    '2. Keep unrelated cleanup out of the change.',
    '3. Run the phase verification with `pnpm run <script>`.',
    '4. Update `journal.md` with status, notes, and any plan deltas.',
    '5. Commit only when the operator explicitly asks for commits.',
    '',
    '## Step 3 - After Execution',
    '',
    'After a phase pin:',
    '',
    '1. Record completed checks in `journal.md`.',
    '2. Mark the phase gate when all pins in that phase are done.',
    '3. Decide whether to continue based on context, quality, and operator direction.',
    '4. Stop at phase boundaries unless the operator asked to continue.',
    '',
    '## Hard Rules',
    '',
    '- Use repository entry points: `pnpm run <script>` and `pnpm exec <bin>`; never `npx`.',
    '- Do not push without explicit operator instruction.',
    '- Do not use `--no-verify` or force-push.',
    '- Do not run destructive git or recursive package commands.',
    '- Do not widen scope beyond the current phase pin.',
    '',
    '## Self-monitoring',
    '',
    'Stop immediately when any of these happens:',
    '',
    '- Context is too full to complete the current phase pin safely.',
    '- The same build, typecheck, lint, or test failure repeats three times.',
    '- The implementation starts cycling through the same edits.',
    '- A file, route, schema, or interface from the phase file is absent or materially different.',
    '- A new dependency, migration, generated artifact, or downstream consumer appears that the plan does not cover.',
    '- The operator gives a direction that conflicts with the current phase.',
    '',
    '## Stop Report Format',
    '',
    '```text',
    '## YYYY-MM-DD - paused at <pin>',
    '',
    '- Trigger: context | quality | dependency-drift | plan-mismatch | operator-decision',
    '- Last completed phase: <phase and sha>',
    '- Current phase in progress: <phase and pin>',
    '- State:',
    '  - build: <green | red>',
    '  - typecheck: <green | red>',
    '  - lint: <green | red>',
    '  - test: <green | red | not run>',
    '  - working-copy: <clean | dirty>',
    '- Specific blocker:',
    '  - <error, file, or missing decision>',
    '- Files modified but not completed:',
    '  - <path> - <reason>',
    '- Recommended next action:',
    '  - <continue | redo | split | ask operator>',
    '- Plan deltas detected:',
    '  - <delta or none>',
    '```',
    '',
  ].join('\n');
}

function renderRemainingDebt(structure: PlanStructure): string {
  const followUps =
    structure.nonGoals.length > 0
      ? structure.nonGoals.map(
          (line) =>
            `| ${line.replace(/^[-*]\s+/, '')} | declared non-goal in the plan | revisit only on explicit operator request |`,
        )
      : ['| - | - | - |'];
  const openItems =
    structure.openQuestions.length > 0
      ? structure.openQuestions.map((line) => `- ${line.replace(/^[-*]\s+/, '')}`)
      : ['- None recorded at emission time.'];
  return [
    `# ${structure.title} - remaining debt`,
    '',
    'This file separates conscious non-scope from accidental leftovers. Do not use it as a place for vague TODOs.',
    '',
    '## Transitional Warnings',
    '',
    '| Item | Current status | Exit condition |',
    '| --- | --- | --- |',
    '| - | - | - |',
    '',
    '## Short-term Cleanup',
    '',
    '| Item | Source | Action | Trigger |',
    '| --- | --- | --- | --- |',
    '| - | - | - | - |',
    '',
    '## Follow-up Roadmap',
    '',
    '| Item | Why it is not in scope | Trigger |',
    '| --- | --- | --- |',
    ...followUps,
    '',
    '## Not Debt',
    '',
    ...openItems,
    '',
  ].join('\n');
}

export function emitPlanPackage(
  work: string,
  finalPlan: string,
  structure: PlanStructure,
  decision: SplitDecision,
): EmitPlanPackageResult {
  if (structure.phases.length === 0) {
    return { kind: 'empty-work-plan' };
  }
  const dir = path.join(work, PACKAGE_DIR_NAME);
  mkdirSync(dir, { recursive: true });

  const plan = path.join(dir, 'plan.md');
  copyFileSync(finalPlan, plan);

  const phaseNames = phaseFileNames(structure.phases);
  const phaseFiles: string[] = [];
  for (let index = 0; index < structure.phases.length; index += 1) {
    const phase = structure.phases[index];
    if (phase === undefined) {
      continue;
    }
    const file = path.join(dir, phaseNames[index] ?? phaseFileName(phase, index));
    writeFileSync(file, renderPhaseDoc(phase, structure.phases, index));
    phaseFiles.push(file);
  }

  const readme = path.join(dir, 'README.md');
  writeFileSync(readme, renderReadme(structure, structure.phases, decision, phaseNames));
  const journal = path.join(dir, 'journal.md');
  writeFileSync(journal, renderJournal(structure));
  const run = path.join(dir, 'run.md');
  writeFileSync(run, renderRunbook(structure.title));
  const remainingDebt = path.join(dir, 'remaining-debt.md');
  writeFileSync(remainingDebt, renderRemainingDebt(structure));

  return {
    kind: 'emitted',
    paths: { dir, readme, plan, run, journal, remainingDebt, phases: phaseFiles },
  };
}

function packageMarkdownFiles(packageDir: string): string[] {
  return readdirSync(packageDir)
    .filter((name) => name.endsWith('.md'))
    .map((name) => path.join(packageDir, name));
}

function listPhaseFiles(packageDir: string): string[] {
  return readdirSync(packageDir)
    .filter((name) => /^phase-\d+-.+\.md$/.test(name))
    .sort()
    .map((name) => path.join(packageDir, name));
}

function phaseIdFromFile(file: string): string | undefined {
  const match = /phase-(\d+)-/.exec(path.basename(file));
  return match ? `P${match[1] ?? ''}` : undefined;
}

function countMissingHeadings(packageDir: string, phaseFiles: readonly string[]): number {
  let missing = 0;
  const checkFile = (file: string, headings: readonly string[]) => {
    if (!existsSync(file)) {
      return;
    }
    for (const heading of headings) {
      if (!planHasHeading(file, heading)) {
        missing += 1;
      }
    }
  };
  const planMd = path.join(packageDir, 'plan.md');
  checkFile(planMd, PLAN_MD_REQUIRED_HEADINGS);
  if (existsSync(planMd) && !planHasImpactGraphMermaid(planMd)) {
    missing += 1;
  }
  checkFile(path.join(packageDir, 'journal.md'), JOURNAL_REQUIRED_HEADINGS);
  checkFile(path.join(packageDir, 'run.md'), RUNBOOK_REQUIRED_HEADINGS);
  for (const file of phaseFiles) {
    checkFile(file, PHASE_REQUIRED_HEADINGS);
  }
  return missing;
}

function tokenPresent(text: string, token: string): boolean {
  return new RegExp(`\\b${token}\\b`).test(text);
}

function readOptionalPackageMarkdown(packageDir: string, name: string): string {
  const file = path.join(packageDir, name);
  if (!existsSync(file)) {
    return '';
  }
  return readFileSync(file, 'utf8');
}

function countBrokenCrossRefs(packageDir: string, phaseFiles: readonly string[]): number {
  const readme = readOptionalPackageMarkdown(packageDir, 'README.md');
  const journal = readOptionalPackageMarkdown(packageDir, 'journal.md');
  const phaseIds = phaseFiles
    .map((file) => phaseIdFromFile(file))
    .filter((id): id is string => id !== undefined);
  let broken = 0;
  for (const id of phaseIds) {
    if (!tokenPresent(readme, id)) {
      broken += 1;
    }
    if (!tokenPresent(journal, id)) {
      broken += 1;
    }
  }
  const referencedNames = new Set(
    [...readme.matchAll(/phase-\d+-[a-z0-9-]+\.md/g)].map((m) => m[0]),
  );
  for (const name of referencedNames) {
    if (!existsSync(path.join(packageDir, name))) {
      broken += 1;
    }
  }
  const tokens = new Set(
    [...readme.matchAll(/\bP\d+\b/g), ...journal.matchAll(/\bP\d+\b/g)].map((m) => m[0]),
  );
  for (const token of tokens) {
    if (!phaseIds.includes(token)) {
      broken += 1;
    }
  }
  return broken;
}

function countForbiddenShell(packageDir: string): number {
  let count = 0;
  for (const file of packageMarkdownFiles(packageDir)) {
    const shell = extractShellBlockText(readFileSync(file, 'utf8'));
    for (const forbidden of FORBIDDEN_SHELL_STRINGS) {
      if (shell.includes(forbidden)) {
        count += 1;
      }
    }
  }
  return count;
}

export function validatePlanPackage(
  projectRoot: string,
  packageDir: string,
  options: ValidatePlanPackageOptions = {},
): PackageHealth {
  if (!existsSync(packageDir) || !statSync(packageDir).isDirectory()) {
    return {
      ok: false,
      emptyWorkPlan: true,
      missingFiles: REQUIRED_PACKAGE_FILES.length,
      missingHeadings: 0,
      brokenCrossRefs: 0,
      forbiddenShell: 0,
      references: EMPTY_FINDINGS_COUNTS,
    };
  }
  let missingFiles = 0;
  for (const name of REQUIRED_PACKAGE_FILES) {
    if (!existsSync(path.join(packageDir, name))) {
      missingFiles += 1;
    }
  }
  const phaseFiles = listPhaseFiles(packageDir);
  if (phaseFiles.length === 0) {
    missingFiles += 1;
  }
  const missingHeadings = countMissingHeadings(packageDir, phaseFiles);
  const brokenCrossRefs = countBrokenCrossRefs(packageDir, phaseFiles);
  const forbiddenShell = countForbiddenShell(packageDir);
  const findingsFile =
    options.findingsFile ?? path.join(path.dirname(packageDir), PACKAGE_FINDINGS_FILE);
  const references = validatePackageReferences(
    projectRoot,
    [path.join(packageDir, 'plan.md'), ...phaseFiles],
    findingsFile,
  );
  const ok =
    missingFiles === 0 && missingHeadings === 0 && brokenCrossRefs === 0 && forbiddenShell === 0;
  return {
    ok,
    emptyWorkPlan: false,
    missingFiles,
    missingHeadings,
    brokenCrossRefs,
    forbiddenShell,
    references,
  };
}
