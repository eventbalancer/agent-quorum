import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

describe('layer boundary', () => {
  it('keeps src/cli modules from importing the public barrel src/index.ts', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cliRoot = path.resolve(here, '../../src/cli');
    const barrel = path.resolve(here, '../../src/index.ts');
    const files = readdirSync(cliRoot, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
      .map((entry) => path.join(entry.parentPath, entry.name));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const barrelImport = path.relative(path.dirname(file), barrel).replace(/\.ts$/, '.js');
      expect(text.includes(`'${barrelImport}'`)).toBe(false);
      expect(text.includes(`"${barrelImport}"`)).toBe(false);
    }
  });
});
