import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { schemaValidQuiet } from './schema.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';

export interface CritiqueHealth {
  total: number;
  addressed: number;
  newIssues: number;
  invalid: number;
  unanchored: number;
  pct: number;
}

export type LineageClass =
  | 'new'
  | 'refinement'
  | 'reopened'
  | 'recurring'
  | 'revision-regression'
  | 'rejected-duplicate'
  | 'invalid-lineage';

export type GroundingClass = 'grounded' | 'malformed' | 'format-mismatch' | 'unanchored';

interface IssueGroundingResult {
  readonly kind: GroundingClass;
  readonly evidenceKinds: string[];
}

export interface EvidenceTargetContext {
  readonly work: string;
  readonly projectRoot: string;
}

export interface ConvergenceHealth {
  readonly lineage: Record<LineageClass, number>;
  readonly grounding: Record<GroundingClass, number>;
  readonly evidenceKinds: Record<string, number>;
}

const EVIDENCE_FILE_LINE = /[\w./-]+\.[A-Za-z][\w-]*:\d+/;
const EVIDENCE_SECTION = /#{1,6}\s+\S/;
const EVIDENCE_TOPOLOGY = /^R-[a-f0-9]{64}$/;
const EVIDENCE_COMMAND =
  /^(?:pnpm|npm|yarn|bun|node|deno|git|docker|kubectl|terraform|cargo|go|python(?:3)?|pytest)\b/i;
const ADDRESSES_REF = /^v([0-9]+)\.(C[0-9]+)$/;
const TYPED_EVIDENCE_KINDS = [
  'file-line',
  'plan-section',
  'phase-gate',
  'command',
  'repository',
  'topology',
] as const;

export function isCritiqueDuplicateIssue(issue: JsonValue): boolean {
  if (!isJsonObject(issue)) {
    return false;
  }
  return issue.duplicate_of !== null && issue.duplicate_of !== undefined;
}

export function critiqueDuplicateIsValid(issue: JsonValue, work: string): boolean {
  if (!isJsonObject(issue) || issue.severity !== 'nit' || typeof issue.duplicate_of !== 'string') {
    return false;
  }
  const rejectedFile = path.join(work, 'rejected-log.jsonl');
  if (!existsSync(rejectedFile)) {
    return false;
  }
  return readFileSync(rejectedFile, 'utf8')
    .split('\n')
    .some((line) => {
      try {
        const value = JSON.parse(line) as JsonValue;
        return isJsonObject(value) && value.id === issue.duplicate_of;
      } catch {
        return false;
      }
    });
}

function evidenceIsAnchored(evidence: JsonValue | undefined): boolean {
  return (
    typeof evidence === 'string' &&
    (EVIDENCE_FILE_LINE.test(evidence) || EVIDENCE_SECTION.test(evidence))
  );
}

function toText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function loadIssues(filePath: string): JsonValue[] {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as JsonValue;
  return isJsonObject(parsed) && Array.isArray(parsed.issues) ? parsed.issues : [];
}

function parentRefIsValid(
  parentIter: number,
  parentId: string,
  iter: number,
  work: string,
  criticSchema: string,
): boolean {
  if (parentIter >= iter) {
    return false;
  }
  const parentFile = path.join(work, `critique.v${parentIter}.json`);
  if (!existsSync(parentFile) || statSync(parentFile).size === 0) {
    return false;
  }
  if (!schemaValidQuiet(parentFile, criticSchema)) {
    return false;
  }
  return loadIssues(parentFile).some((p) => isJsonObject(p) && p.id === parentId);
}

type IssueClass = 'new' | 'addressed' | 'invalid';

function classifyRef(ref: string, iter: number, work: string, criticSchema: string): IssueClass {
  if (!ref) {
    return 'new';
  }
  const match = ADDRESSES_REF.exec(ref);
  if (!match) {
    return 'invalid';
  }
  return parentRefIsValid(Number(match[1]), match[2] ?? '', iter, work, criticSchema)
    ? 'addressed'
    : 'invalid';
}

// Classify each issue's `addresses` reference: empty → new, vN.Cn pointing at
// a real issue in an earlier valid critique → addressed, anything else →
// invalid. pct is the integer percentage of valid-addressed issues.
export function critiqueHealth(
  work: string,
  criticSchema: string,
  iter: number,
  critiqueFile: string,
): CritiqueHealth {
  const issues = loadIssues(critiqueFile);
  let total = 0;
  let addressed = 0;
  let newIssues = 0;
  let invalid = 0;
  let unanchored = 0;

  for (const issue of issues) {
    if (critiqueDuplicateIsValid(issue, work)) {
      continue;
    }
    const obj = isJsonObject(issue) ? issue : {};
    total += 1;
    if (
      !evidenceIsAnchored(obj.evidence) &&
      !evidenceReferencesStructurallyValid(obj.evidence_refs)
    ) {
      unanchored += 1;
    }
    if (!toText(obj.id)) {
      continue;
    }
    const ref = obj.addresses === false ? '' : toText(obj.addresses);
    const kind = classifyRef(ref, iter, work, criticSchema);
    if (kind === 'new') {
      newIssues += 1;
    } else if (kind === 'addressed') {
      addressed += 1;
    } else {
      invalid += 1;
    }
  }

  const pct = total > 0 ? Math.floor((addressed * 100) / total) : 100;
  return { total, addressed, newIssues, invalid, unanchored, pct };
}

function emptyLineage(): Record<LineageClass, number> {
  return {
    new: 0,
    refinement: 0,
    reopened: 0,
    recurring: 0,
    'revision-regression': 0,
    'rejected-duplicate': 0,
    'invalid-lineage': 0,
  };
}

function emptyGrounding(): Record<GroundingClass, number> {
  return { grounded: 0, malformed: 0, 'format-mismatch': 0, unanchored: 0 };
}

function typedEvidenceSyntax(ref: Record<string, JsonValue>): boolean {
  const value = typeof ref.value === 'string' ? ref.value : '';
  switch (ref.kind) {
    case 'file-line':
      return (
        (typeof ref.path === 'string' &&
          ref.path.trim() !== '' &&
          Number.isInteger(ref.line) &&
          Number(ref.line) > 0) ||
        EVIDENCE_FILE_LINE.test(value)
      );
    case 'plan-section':
      return (
        (typeof ref.section === 'string' && ref.section.trim() !== '') ||
        EVIDENCE_SECTION.test(value)
      );
    case 'phase-gate':
      return (
        (typeof ref.phase === 'string' &&
          ref.phase.trim() !== '' &&
          typeof ref.gate === 'string' &&
          ref.gate.trim() !== '') ||
        /^[^:]+:\s*[^:]+/.test(value)
      );
    case 'command':
      return (typeof ref.command === 'string' && ref.command.trim() !== '') || value.trim() !== '';
    case 'repository':
      return (
        (typeof ref.repository === 'string' && ref.repository.trim() !== '') || value.trim() !== ''
      );
    case 'topology':
      return (
        (typeof ref.topology_id === 'string' && EVIDENCE_TOPOLOGY.test(ref.topology_id)) ||
        EVIDENCE_TOPOLOGY.test(value)
      );
    default:
      return false;
  }
}

export function evidenceReferencesStructurallyValid(value: JsonValue | undefined): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every(
    (entry) =>
      isJsonObject(entry) &&
      typeof entry.kind === 'string' &&
      (TYPED_EVIDENCE_KINDS as readonly string[]).includes(entry.kind) &&
      typedEvidenceSyntax(entry) &&
      !evidenceFormatMismatch(entry),
  );
}

export function evidenceReferencesGrounded(
  value: JsonValue | undefined,
  context: EvidenceTargetContext,
  planVersion: number,
): boolean {
  return (
    evidenceReferencesStructurallyValid(value) &&
    Array.isArray(value) &&
    value.some(
      (entry) =>
        isJsonObject(entry) &&
        typedEvidenceTargetExists(entry, context.work, planVersion, context.projectRoot),
    )
  );
}

function evidenceFormatMismatch(ref: Record<string, JsonValue>): boolean {
  const value = typeof ref.value === 'string' ? ref.value : '';
  return (
    (ref.kind !== 'file-line' && EVIDENCE_FILE_LINE.test(value)) ||
    (ref.kind !== 'plan-section' && EVIDENCE_SECTION.test(value)) ||
    (ref.kind !== 'topology' &&
      (EVIDENCE_TOPOLOGY.test(value) || typeof ref.topology_id === 'string')) ||
    (ref.kind !== 'command' && (EVIDENCE_COMMAND.test(value) || typeof ref.command === 'string')) ||
    (ref.kind !== 'phase-gate' &&
      (typeof ref.phase === 'string' || typeof ref.gate === 'string')) ||
    (ref.kind !== 'repository' && typeof ref.repository === 'string')
  );
}

function containsEvidenceToken(text: string, token: string): boolean {
  const comparableText = text.replace(/`+/g, '');
  const normalized = token.replace(/`+/g, '').trim();
  if (normalized === '') {
    return false;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^A-Za-z0-9_@/.:-])${escaped}(?=$|[^A-Za-z0-9_@/.:-])`, 'i').test(
    comparableText,
  );
}

export function planPhaseGateExists(plan: string, phase: string, gate: string): boolean {
  const lines = plan.split('\n');
  if (
    lines.some((line) => containsEvidenceToken(line, phase) && containsEvidenceToken(line, gate))
  ) {
    return true;
  }
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{2,6})\s+(.+)$/.exec(lines[index] ?? '');
    if (heading === null || !containsEvidenceToken(heading[2] ?? '', phase)) {
      continue;
    }
    const level = (heading[1] ?? '').length;
    let end = index + 1;
    while (end < lines.length) {
      const next = /^(#{2,6})\s+/.exec(lines[end] ?? '');
      if (next !== null && (next[1] ?? '').length <= level) {
        break;
      }
      end += 1;
    }
    if (containsEvidenceToken(lines.slice(index + 1, end).join('\n'), gate)) {
      return true;
    }
  }
  return false;
}

function typedEvidenceTargetExists(
  ref: JsonObject,
  work: string,
  iter: number,
  projectRoot: string,
): boolean {
  const value = typeof ref.value === 'string' ? ref.value : '';
  const withinProject = (candidate: string) => {
    const resolvedRoot = path.resolve(projectRoot);
    const resolvedCandidate = path.resolve(candidate);
    const lexical = path.relative(resolvedRoot, resolvedCandidate);
    if (
      lexical !== '' &&
      (lexical === '..' || lexical.startsWith(`..${path.sep}`) || path.isAbsolute(lexical))
    ) {
      return false;
    }
    if (!existsSync(resolvedCandidate)) {
      return true;
    }
    try {
      const physical = path.relative(realpathSync(resolvedRoot), realpathSync(resolvedCandidate));
      return (
        physical === '' ||
        (physical !== '..' && !physical.startsWith(`..${path.sep}`) && !path.isAbsolute(physical))
      );
    } catch {
      return false;
    }
  };
  const authoritativeSource = (candidate: string) => {
    const systemFile = path.join(work, 'system-context.json');
    if (!existsSync(systemFile)) {
      return false;
    }
    try {
      const system = JSON.parse(readFileSync(systemFile, 'utf8')) as JsonValue;
      const sources = isJsonObject(system) && Array.isArray(system.sources) ? system.sources : [];
      return sources.some(
        (source) =>
          isJsonObject(source) &&
          typeof source.path === 'string' &&
          path.resolve(source.path) === path.resolve(candidate),
      );
    } catch {
      return false;
    }
  };
  switch (ref.kind) {
    case 'file-line': {
      const match = EVIDENCE_FILE_LINE.exec(value);
      const file = typeof ref.path === 'string' ? ref.path : match?.[0]?.replace(/:\d+$/, '');
      const line = typeof ref.line === 'number' ? ref.line : Number(/:(\d+)$/.exec(value)?.[1]);
      if (file === undefined || !Number.isInteger(line) || line < 1) {
        return false;
      }
      const resolved = path.isAbsolute(file) ? file : path.join(projectRoot, file);
      return (
        (withinProject(resolved) || authoritativeSource(resolved)) &&
        existsSync(resolved) &&
        readFileSync(resolved, 'utf8').split('\n').length >= line
      );
    }
    case 'plan-section': {
      const section = (typeof ref.section === 'string' ? ref.section : value).replace(/^#+\s*/, '');
      const planFile = path.join(work, `plan.v${iter}.md`);
      return (
        existsSync(planFile) &&
        readFileSync(planFile, 'utf8')
          .split('\n')
          .some((line) => /^#{1,6}\s+/.test(line) && line.replace(/^#+\s*/, '').trim() === section)
      );
    }
    case 'repository': {
      const repository = typeof ref.repository === 'string' ? ref.repository : value;
      const repositoryPath = path.isAbsolute(repository)
        ? repository
        : path.join(projectRoot, repository);
      if (withinProject(repositoryPath) && existsSync(repositoryPath)) {
        return true;
      }
      const systemFile = path.join(work, 'system-context.json');
      if (!existsSync(systemFile)) {
        return false;
      }
      try {
        const system = JSON.parse(readFileSync(systemFile, 'utf8')) as JsonValue;
        const facts = isJsonObject(system) && isJsonObject(system.facts) ? system.facts : {};
        return Array.isArray(facts.repositories) && facts.repositories.includes(repository);
      } catch {
        return false;
      }
    }
    case 'topology': {
      const id = typeof ref.topology_id === 'string' ? ref.topology_id : value;
      const systemFile = path.join(work, 'system-context.json');
      return existsSync(systemFile) && readFileSync(systemFile, 'utf8').includes(id);
    }
    case 'phase-gate': {
      const planFile = path.join(work, `plan.v${iter}.md`);
      if (!existsSync(planFile)) {
        return false;
      }
      const plan = readFileSync(planFile, 'utf8');
      const valueParts = /^([^:]+):\s*(.+)$/.exec(value);
      const phase = typeof ref.phase === 'string' ? ref.phase.trim() : valueParts?.[1]?.trim();
      const gate = typeof ref.gate === 'string' ? ref.gate.trim() : valueParts?.[2]?.trim();
      return (
        phase !== undefined &&
        phase !== '' &&
        gate !== undefined &&
        gate !== '' &&
        planPhaseGateExists(plan, phase, gate)
      );
    }
    case 'command': {
      const command = typeof ref.command === 'string' ? ref.command : value;
      if (command.trim() === '') {
        return false;
      }
      const planFile = path.join(work, `plan.v${iter}.md`);
      if (existsSync(planFile) && readFileSync(planFile, 'utf8').includes(command)) {
        return true;
      }
      const systemFile = path.join(work, 'system-context.json');
      return existsSync(systemFile) && readFileSync(systemFile, 'utf8').includes(command);
    }
    default:
      return false;
  }
}

function issueGrounding(
  issue: JsonObject,
  work: string,
  iter: number,
  projectRoot: string,
): IssueGroundingResult {
  const refs = Array.isArray(issue.evidence_refs) ? issue.evidence_refs.filter(isJsonObject) : [];
  if (refs.length > 0) {
    const kinds = refs
      .map((ref) => (typeof ref.kind === 'string' ? ref.kind : 'unknown'))
      .filter((kind) => kind !== 'unknown');
    if (
      refs.some(
        (ref) =>
          typeof ref.kind !== 'string' ||
          !(TYPED_EVIDENCE_KINDS as readonly string[]).includes(ref.kind),
      )
    ) {
      return { kind: 'malformed', evidenceKinds: kinds };
    }
    if (refs.some(evidenceFormatMismatch)) {
      return { kind: 'format-mismatch', evidenceKinds: kinds };
    }
    return {
      kind: evidenceReferencesGrounded(issue.evidence_refs, { work, projectRoot }, iter)
        ? 'grounded'
        : 'malformed',
      evidenceKinds: kinds,
    };
  }
  if (typeof issue.evidence !== 'string' || issue.evidence.trim() === '') {
    return { kind: 'unanchored', evidenceKinds: [] };
  }
  const fileLine = EVIDENCE_FILE_LINE.exec(issue.evidence);
  if (fileLine !== null) {
    const value = fileLine[0];
    return {
      kind: typedEvidenceTargetExists({ kind: 'file-line', value }, work, iter, projectRoot)
        ? 'grounded'
        : 'malformed',
      evidenceKinds: ['legacy'],
    };
  }
  const section = EVIDENCE_SECTION.exec(issue.evidence);
  if (section !== null) {
    return {
      kind: typedEvidenceTargetExists(
        { kind: 'plan-section', value: section[0] },
        work,
        iter,
        projectRoot,
      )
        ? 'grounded'
        : 'malformed',
      evidenceKinds: ['legacy'],
    };
  }
  if (/\b[\w./-]+\.[A-Za-z][\w-]*:\S+/.test(issue.evidence)) {
    return { kind: 'malformed', evidenceKinds: ['legacy'] };
  }
  return { kind: 'unanchored', evidenceKinds: [] };
}

function updateRejected(work: string, iter: number, id: string): boolean {
  const file = path.join(work, `update.v${iter}.json`);
  if (!existsSync(file)) {
    return false;
  }
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
    const issues = isJsonObject(value) && Array.isArray(value.issues) ? value.issues : [];
    return issues.some(
      (issue) =>
        isJsonObject(issue) &&
        issue.id === id &&
        typeof issue.verdict === 'string' &&
        (issue.verdict.startsWith('reject_') || issue.verdict === 'duplicate_of_prior'),
    );
  } catch {
    return false;
  }
}

function lineageClass(
  issue: JsonObject,
  iter: number,
  work: string,
  criticSchema: string,
): LineageClass {
  if (isCritiqueDuplicateIssue(issue)) {
    if (issue.severity !== 'nit') {
      return 'invalid-lineage';
    }
    const duplicate = typeof issue.duplicate_of === 'string' ? issue.duplicate_of : '';
    const rejectedFile = path.join(work, 'rejected-log.jsonl');
    if (!existsSync(rejectedFile)) {
      return 'invalid-lineage';
    }
    const exists = readFileSync(rejectedFile, 'utf8')
      .split('\n')
      .some((line) => {
        try {
          const value = JSON.parse(line) as JsonValue;
          return isJsonObject(value) && value.id === duplicate;
        } catch {
          return false;
        }
      });
    return exists ? 'rejected-duplicate' : 'invalid-lineage';
  }
  const ref = typeof issue.addresses === 'string' ? issue.addresses : '';
  const invariantId = typeof issue.invariant_id === 'string' ? issue.invariant_id : '';
  if (ref !== '') {
    const match = ADDRESSES_REF.exec(ref);
    if (
      match === null ||
      !parentRefIsValid(Number(match[1]), match[2] ?? '', iter, work, criticSchema)
    ) {
      return 'invalid-lineage';
    }
  }
  if (invariantId !== '') {
    const convergenceFile = path.join(work, `convergence.v${iter}.json`);
    if (!existsSync(convergenceFile)) {
      return 'invalid-lineage';
    }
    try {
      const convergence = JSON.parse(readFileSync(convergenceFile, 'utf8')) as JsonValue;
      const invariants =
        isJsonObject(convergence) && Array.isArray(convergence.invariants)
          ? convergence.invariants.filter(isJsonObject)
          : [];
      if (!invariants.some((entry) => entry.id === invariantId)) {
        return 'invalid-lineage';
      }
    } catch {
      return 'invalid-lineage';
    }
  }
  if (typeof issue.introduced_by_revision === 'string') {
    return issue.introduced_by_revision === `plan.v${iter}.md` && iter > 0
      ? 'revision-regression'
      : 'invalid-lineage';
  }
  if (ref === '') {
    if (invariantId === '') {
      return 'new';
    }
    const convergenceFile = path.join(work, `convergence.v${iter}.json`);
    try {
      const convergence = JSON.parse(readFileSync(convergenceFile, 'utf8')) as JsonValue;
      const invariants =
        isJsonObject(convergence) && Array.isArray(convergence.invariants)
          ? convergence.invariants.filter(isJsonObject)
          : [];
      const invariant = invariants.find((entry) => entry.id === invariantId);
      if (invariant === undefined) {
        return 'invalid-lineage';
      }
      return invariant.status === 'resolved' ? 'reopened' : 'recurring';
    } catch {
      return 'invalid-lineage';
    }
  }
  const match = ADDRESSES_REF.exec(ref);
  if (match === null) {
    return 'invalid-lineage';
  }
  const parentIter = Number(match[1]);
  if (updateRejected(work, parentIter, match[2] ?? '')) {
    return 'reopened';
  }
  return parentIter === iter - 1 ? 'refinement' : 'recurring';
}

export function convergenceHealth(
  work: string,
  criticSchema: string,
  iter: number,
  critiqueFile: string,
  projectRoot = process.cwd(),
): ConvergenceHealth {
  const lineage = emptyLineage();
  const grounding = emptyGrounding();
  const evidenceKinds: Record<string, number> = {};
  for (const value of loadIssues(critiqueFile)) {
    const issue = isJsonObject(value) ? value : {};
    lineage[lineageClass(issue, iter, work, criticSchema)] += 1;
    const result = issueGrounding(issue, work, iter, projectRoot);
    grounding[result.kind] += 1;
    for (const kind of result.evidenceKinds) {
      evidenceKinds[kind] = (evidenceKinds[kind] ?? 0) + 1;
    }
  }
  return { lineage, grounding, evidenceKinds };
}
