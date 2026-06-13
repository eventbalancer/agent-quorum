import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HaltError } from '../../runtime/halt.js';
import { err, log } from '../../runtime/log.js';

export const PLAN_DOCUMENT_REQUIRED_SECTIONS = [
  'At a Glance',
  'Context',
  'Verified Facts',
  'Target State',
  'Scope',
  'Work Plan',
  'Files and Interfaces',
  'Verification',
  'STOP Triggers',
  'Impact Graph',
];

const SPACE = '[ \\t\\v\\f\\r]';

function fileLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

export function planHasTitleHeading(file: string): boolean {
  if (!existsSync(file)) {
    return false;
  }
  const first = fileLines(file)[0] ?? '';
  return new RegExp(`^#${SPACE}+[^ \\t\\v\\f\\r]`).test(first);
}

export function planHasHeading(file: string, heading: string): boolean {
  const pattern = new RegExp(`^##${SPACE}+${heading}(${SPACE}|$|[-(:])`);
  return fileLines(file).some((line) => pattern.test(line));
}

export function planHasImpactGraphMermaid(file: string): boolean {
  const headingPattern = new RegExp(`^##${SPACE}+Impact Graph(${SPACE}|$|[-(:])`);
  const anyHeading = new RegExp(`^##${SPACE}+`);
  let inSection = false;
  for (const line of fileLines(file)) {
    if (headingPattern.test(line)) {
      inSection = true;
      continue;
    }
    if (anyHeading.test(line) && inSection) {
      break;
    }
    if (inSection && /^```mermaid[ \t\v\f]*$/.test(line)) {
      return true;
    }
  }
  return false;
}

export interface PlanShapeHealth {
  readonly missing: number;
  readonly graph: 0 | 1;
}

export function planDocumentShapeHealth(file: string): PlanShapeHealth {
  let missing = 0;
  for (const heading of PLAN_DOCUMENT_REQUIRED_SECTIONS) {
    if (!planHasHeading(file, heading)) {
      missing += 1;
    }
  }
  return { missing, graph: planHasImpactGraphMermaid(file) ? 1 : 0 };
}

export function planDocumentShapeOk(file: string): boolean {
  const { missing, graph } = planDocumentShapeHealth(file);
  return planHasTitleHeading(file) && missing === 0 && graph === 1;
}

export function validatePlanDocumentShape(file: string): void {
  const title = planHasTitleHeading(file) ? 1 : 0;
  if (title === 0) {
    log('WARNING: plan document must start with a level-1 title');
  }
  for (const heading of PLAN_DOCUMENT_REQUIRED_SECTIONS) {
    if (!planHasHeading(file, heading)) {
      log(`WARNING: plan document missing section: ${heading}`);
    }
  }
  if (!planHasImpactGraphMermaid(file) && planHasHeading(file, 'Impact Graph')) {
    log('WARNING: Impact Graph has no mermaid flowchart');
  }
  const { missing, graph } = planDocumentShapeHealth(file);
  if (title === 1 && missing === 0 && graph === 1) {
    log('  → plan_shape=structured impact_graph=mermaid');
  } else {
    log(
      `  → plan_shape=needs-attention missing_sections=${missing} impact_graph_mermaid=${graph} title_h1=${title}`,
    );
  }
}

// 1-based line number of the first level-1 `# ` title outside fenced code
// blocks; undefined when the document has none.
export function planFirstTitleLine(file: string): number | undefined {
  const titlePattern = new RegExp(`^#${SPACE}+[^ \\t\\v\\f\\r]`);
  let fence = false;
  const lines = fileLines(file);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      fence = !fence;
      continue;
    }
    if (!fence && titlePattern.test(line)) {
      return i + 1;
    }
  }
  return undefined;
}

function planHealInlineFirstLineTitle(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  if (planHasTitleHeading(file)) {
    return;
  }
  const content = readFileSync(file, 'utf8');
  const firstLine = content.split('\n')[0] ?? '';
  if (firstLine === '') {
    return;
  }
  if (firstLine.startsWith('\ufeff')) {
    return;
  }
  const match = new RegExp(`#${SPACE}+[^ \\t\\v\\f\\r].*$`).exec(firstLine);
  if (!match) {
    return;
  }
  const titleLine = match[0];
  copyFileSync(file, `${file}.raw`);
  const rest = content.split('\n').slice(1).join('\n');
  writeFileSync(file, `${titleLine}\n${rest}`);
  log(
    `  → normalized plan artifact: split inline title from line 1 (raw kept at ${path.basename(file)}.raw)`,
  );
}

// Self-heal a captured artifact in place: drop conversational preamble before
// the plan title, or split a title glued onto the first prose line. The raw
// capture is preserved at <file>.raw. Idempotent.
export function normalizePlanDocument(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  if (planHasTitleHeading(file)) {
    return;
  }
  const firstTitle = planFirstTitleLine(file);
  if (firstTitle !== undefined && firstTitle > 1) {
    copyFileSync(file, `${file}.raw`);
    const content = readFileSync(`${file}.raw`, 'utf8');
    writeFileSync(
      file,
      content
        .split('\n')
        .slice(firstTitle - 1)
        .join('\n'),
    );
    log(
      `  → normalized plan artifact: stripped ${firstTitle - 1} preamble line(s) before title (raw kept at ${path.basename(file)}.raw)`,
    );
  } else if (firstTitle === undefined) {
    planHealInlineFirstLineTitle(file);
  }
}

export function requirePlanDocumentShape(file: string): void {
  const { missing, graph } = planDocumentShapeHealth(file);
  const title = planHasTitleHeading(file) ? 1 : 0;
  if (!planDocumentShapeOk(file)) {
    const message = `plan shape gate failed: missing_sections=${missing} impact_graph_mermaid=${graph} title_h1=${title} (artifact is not a complete plan — likely a summary, wrapper, or external-file pointer)`;
    err(message);
    throw new HaltError(message, 4, true);
  }
}
