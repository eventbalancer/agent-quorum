import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ReadinessAdmissionError } from '../../core/readiness-admission.js';

function sectionNames(candidateContent: string): string[] {
  return candidateContent.split('\n').flatMap((line) => {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(line);
    return match?.[1] === undefined ? [] : [match[1]];
  });
}

export function candidateEvidenceAnchorPrompt(
  candidateFile: string,
  candidateContent = readFileSync(candidateFile, 'utf8'),
): string {
  const basename = path.basename(candidateFile);
  const lineCount = candidateContent.split('\n').length;
  const sections = sectionNames(candidateContent);
  return [
    '## Deterministic candidate evidence anchors',
    `candidate_file: ${basename}`,
    `candidate_line_range: 1-${lineCount}`,
    'exact_plan_sections:',
    ...(sections.length === 0 ? ['- none'] : sections.map((section) => `- ${section}`)),
    '',
    'Grounding rules:',
    `- A candidate file-line reference must use path "${basename}" and a line from 1 through ${lineCount}.`,
    '- A plan-section reference must copy one exact name from exact_plan_sections, without a # prefix.',
    '- A phase-gate reference is valid only when both strings occur in the same phase row or phase section of this candidate.',
    '- A conclusive applicability or occurrence disposition must cite at least one exact current-candidate anchor. Repository context alone is not a current-candidate anchor.',
    "- If no current-candidate anchor supports a conclusive value, use the schema's unresolved or unknown value and mark completeness false where the schema permits it.",
  ].join('\n');
}

export function structuredOutputRepairPrompt(label: string): string {
  return [
    '## Deterministic output repair',
    `The previous ${label} output failed deterministic validation.`,
    'Regenerate the complete output from the supplied source material. Do not return a patch or commentary.',
    'Re-check every required identity, summary field, and typed evidence reference before returning it.',
  ].join('\n');
}

export function readinessAdmissionRepairPrompt(error: ReadinessAdmissionError): string {
  return [
    '## Deterministic semantic-admission repair',
    'The previous structured output was rejected without changing trusted readiness state.',
    `role: ${error.role}`,
    `code: ${error.code}`,
    `path: ${error.path}`,
    'Regenerate the complete output. Correct the rejected field and re-check all exact identities, derived summaries, plan versions, and candidate-grounded evidence references.',
    'Use only evidence anchors that are present in the supplied deterministic candidate anchor catalog. Do not reuse an ungrounded reference.',
  ].join('\n');
}

export function admissionFailureLogLabel(label: string, error: ReadinessAdmissionError): string {
  return `${label} output failed semantic admission (code=${error.code} path=${error.path})`;
}
