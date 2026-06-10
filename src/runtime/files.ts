import { existsSync, readFileSync, statSync } from 'node:fs';

// bash `[[ -s file ]]`: the file exists and is non-empty.
export function nonEmptyFile(file: string): boolean {
  return existsSync(file) && statSync(file).size > 0;
}

// `wc -l`: the number of newline characters, not visual lines.
export function countNewlines(text: string): number {
  let count = 0;
  for (const ch of text) {
    if (ch === '\n') {
      count += 1;
    }
  }
  return count;
}

export function fileLineCount(file: string): number {
  return countNewlines(readFileSync(file, 'utf8'));
}
