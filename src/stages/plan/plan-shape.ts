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
const BOM = '\uFEFF';
const BLANK_LINE_PATTERN = new RegExp(`^${SPACE}*$`);
const FRONTMATTER_DELIM_PATTERN = new RegExp(`^---${SPACE}*$`);
const TITLE_HEADING_PATTERN = new RegExp(`^#${SPACE}+[^ \\t\\v\\f\\r]`);
const TITLE_INLINE_PATTERN = new RegExp(`#${SPACE}+[^ \\t\\v\\f\\r].*$`);
const MERMAID_FENCE_PATTERN = new RegExp(`^\`\`\`mermaid${SPACE}*$`);
const PHASE_COUNT_PATTERN = new RegExp(`^phase_count:${SPACE}+\\d+${SPACE}*$`);
const EFFORT_TOTAL_PATTERN = new RegExp(`^effort_total:${SPACE}+[^ \\t\\v\\f\\r]`);
const STATUS_PATTERN = new RegExp(`^status:${SPACE}+(clean|needs-review|blocked)${SPACE}*$`);
const FENCE_OPEN_PATTERN = /^```\w/;
const FENCE_CLOSE_PATTERN = /^```\s*$/;
const YAML_LIST_ITEM_PATTERN = /^[ \t]+-/;

function fileLines(file: string): string[] {
  return readFileSync(file, 'utf8').split('\n');
}

// Returns the number of lines occupied by a leading ---...--- frontmatter block
// (both delimiters included). Returns 0 when line 0 is not a delimiter or the
// block is unterminated. Delimiter matching uses SPACE so a CRLF ---\r matches.
function leadingFrontmatterSpan(lines: readonly string[]): number {
  if (!FRONTMATTER_DELIM_PATTERN.test(lines[0] ?? '')) {
    return 0;
  }
  for (let i = 1; i < lines.length; i += 1) {
    if (FRONTMATTER_DELIM_PATTERN.test(lines[i] ?? '')) {
      return i + 1;
    }
  }
  return 0;
}

function frontmatterKeepIndexBeforeTitle(
  lines: readonly string[],
  titleLine0Based: number,
): number {
  let keepFrom = titleLine0Based;
  let checkIdx = keepFrom - 1;
  while (checkIdx >= 0 && BLANK_LINE_PATTERN.test(lines[checkIdx] ?? '')) {
    checkIdx -= 1;
  }
  if (checkIdx >= 0 && FRONTMATTER_DELIM_PATTERN.test(lines[checkIdx] ?? '')) {
    const closingIdx = checkIdx;
    for (let j = closingIdx - 1; j >= 0; j -= 1) {
      if (FRONTMATTER_DELIM_PATTERN.test(lines[j] ?? '')) {
        keepFrom = j;
        break;
      }
    }
  }
  return keepFrom;
}

export function planHasTitleHeading(file: string): boolean {
  if (!existsSync(file)) {
    return false;
  }
  const lines = fileLines(file);
  const span = leadingFrontmatterSpan(lines);
  let idx = span;
  if (span > 0) {
    while (idx < lines.length && BLANK_LINE_PATTERN.test(lines[idx] ?? '')) {
      idx += 1;
    }
  }
  const targetLine = lines[idx] ?? '';
  return TITLE_HEADING_PATTERN.test(targetLine);
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
    if (inSection && MERMAID_FENCE_PATTERN.test(line)) {
      return true;
    }
  }
  return false;
}

// Returns true iff the file begins with a structurally valid YAML frontmatter
// block: a leading ---...--- block with all four required keys at column 0, an
// integer phase_count, a non-empty effort_total, a well-formed status enum, and
// at least one phases list item. All matching uses SPACE for CRLF tolerance.
// Per-phase {name,effort} completeness and phase_count↔Work-Plan-row consistency
// are not checked here (no YAML parser; the critic enforces them).
export function planHasFrontmatter(file: string): boolean {
  const lines = fileLines(file);
  const span = leadingFrontmatterSpan(lines);
  if (span === 0) {
    return false;
  }
  const inner = lines.slice(1, span - 1);

  const phaseCountLine = inner.find((l) => l.startsWith('phase_count:'));
  const effortTotalLine = inner.find((l) => l.startsWith('effort_total:'));
  const phasesIdx = inner.findIndex((l) => l.startsWith('phases:'));
  const statusLine = inner.find((l) => l.startsWith('status:'));

  if (!phaseCountLine || !effortTotalLine || phasesIdx === -1 || !statusLine) {
    return false;
  }

  if (!PHASE_COUNT_PATTERN.test(phaseCountLine)) {
    return false;
  }

  if (!EFFORT_TOTAL_PATTERN.test(effortTotalLine)) {
    return false;
  }

  if (!STATUS_PATTERN.test(statusLine)) {
    return false;
  }

  return inner.slice(phasesIdx + 1).some((l) => YAML_LIST_ITEM_PATTERN.test(l));
}

export interface PlanShapeHealth {
  readonly missing: number;
  readonly graph: 0 | 1;
  readonly frontmatter: 0 | 1;
}

export function planDocumentShapeHealth(file: string): PlanShapeHealth {
  let missing = 0;
  for (const heading of PLAN_DOCUMENT_REQUIRED_SECTIONS) {
    if (!planHasHeading(file, heading)) {
      missing += 1;
    }
  }
  return {
    missing,
    graph: planHasImpactGraphMermaid(file) ? 1 : 0,
    frontmatter: planHasFrontmatter(file) ? 1 : 0,
  };
}

export function planDocumentShapeOk(file: string): boolean {
  const { missing, graph, frontmatter } = planDocumentShapeHealth(file);
  return planHasTitleHeading(file) && missing === 0 && graph === 1 && frontmatter === 1;
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
  const { missing, graph, frontmatter } = planDocumentShapeHealth(file);
  if (frontmatter === 0) {
    log('WARNING: plan document missing valid leading YAML frontmatter block');
  }
  if (title === 1 && missing === 0 && graph === 1 && frontmatter === 1) {
    log('  → plan_shape=structured impact_graph=mermaid frontmatter=1');
  } else {
    log(
      `  → plan_shape=needs-attention missing_sections=${missing} impact_graph_mermaid=${graph} title_h1=${title} frontmatter=${frontmatter}`,
    );
  }
}

// 1-based line number of the first level-1 `# ` title outside fenced code
// blocks and outside a leading frontmatter block; undefined when the document
// has none.
export function planFirstTitleLine(file: string): number | undefined {
  let fence = false;
  const lines = fileLines(file);
  const skip = leadingFrontmatterSpan(lines);
  for (let i = skip; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (line.startsWith('```')) {
      fence = !fence;
      continue;
    }
    if (!fence && TITLE_HEADING_PATTERN.test(line)) {
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
  if (firstLine.startsWith(BOM)) {
    return;
  }
  const match = TITLE_INLINE_PATTERN.exec(firstLine);
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

// Strip an outer code fence that wraps the entire plan body. Handles the case
// where the creator responds with:
//   <optional preamble>
//   ```text   (or ```markdown, ```md, etc.)
//   <actual plan — frontmatter + title + sections>
//   ```
// Tracks nesting so inner fences (```mermaid, ```ts …) are not confused with
// the outer closer. Returns true when the file was rewritten.
function planStripOuterFence(file: string): boolean {
  const lines = fileLines(file);

  let openerIdx = -1;
  for (let i = 0; i < Math.min(lines.length, 10); i += 1) {
    if (FENCE_OPEN_PATTERN.test(lines[i] ?? '')) {
      openerIdx = i;
      break;
    }
  }
  if (openerIdx < 0) {
    return false;
  }
  for (let i = 0; i < openerIdx; i += 1) {
    if ((lines[i] ?? '').startsWith('```')) {
      return false;
    }
  }

  let depth = 1;
  let closerIdx = -1;
  for (let i = openerIdx + 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (FENCE_OPEN_PATTERN.test(line)) {
      depth += 1;
    } else if (FENCE_CLOSE_PATTERN.test(line)) {
      depth -= 1;
      if (depth === 0) {
        closerIdx = i;
        break;
      }
    }
  }
  if (closerIdx < 0) {
    return false;
  }
  for (let i = closerIdx + 1; i < lines.length; i += 1) {
    if ((lines[i] ?? '').trim() !== '') {
      return false;
    }
  }

  const inner = lines.slice(openerIdx + 1, closerIdx);
  const looksLikePlan =
    FRONTMATTER_DELIM_PATTERN.test(inner[0] ?? '') ||
    inner.some((l) => TITLE_HEADING_PATTERN.test(l));
  if (!looksLikePlan) {
    return false;
  }

  copyFileSync(file, `${file}.raw`);
  writeFileSync(file, inner.join('\n'));
  log(
    `  → normalized plan artifact: stripped outer code fence (${openerIdx} preamble line(s), raw kept at ${path.basename(file)}.raw)`,
  );
  return true;
}

// Self-heal a captured artifact in place: drop conversational preamble before
// the plan title (preserving a leading frontmatter block that precedes the
// title), strip an outer code fence wrapping the entire plan, or split a title
// glued onto the first prose line. The raw capture is preserved at <file>.raw.
// Idempotent.
export function normalizePlanDocument(file: string): void {
  if (!existsSync(file)) {
    return;
  }
  if (planHasTitleHeading(file)) {
    return;
  }
  const lines = fileLines(file);
  const firstTitle = planFirstTitleLine(file);
  if (firstTitle !== undefined && firstTitle > 1) {
    const keepFrom = frontmatterKeepIndexBeforeTitle(lines, firstTitle - 1);
    copyFileSync(file, `${file}.raw`);
    const content = readFileSync(`${file}.raw`, 'utf8');
    writeFileSync(file, content.split('\n').slice(keepFrom).join('\n'));
    log(
      `  → normalized plan artifact: stripped ${keepFrom} preamble line(s) before title (raw kept at ${path.basename(file)}.raw)`,
    );
  } else if (firstTitle === undefined) {
    if (!planStripOuterFence(file)) {
      planHealInlineFirstLineTitle(file);
    }
  }
}

export function requirePlanDocumentShape(file: string): void {
  const { missing, graph, frontmatter } = planDocumentShapeHealth(file);
  const title = planHasTitleHeading(file) ? 1 : 0;
  if (!planDocumentShapeOk(file)) {
    const message = `plan shape gate failed: missing_sections=${missing} impact_graph_mermaid=${graph} title_h1=${title} frontmatter=${frontmatter} (artifact is not a complete plan — likely a summary, wrapper, or external-file pointer)`;
    err(message);
    throw new HaltError(message, 4, true);
  }
}
