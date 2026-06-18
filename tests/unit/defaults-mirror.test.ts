import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/core/defaults.js';
import { REPO_ROOT } from '../helpers/harness.js';

describe('config.example.json mirrors DEFAULT_CONFIG', () => {
  it('serializes every default section and value', () => {
    const raw = readFileSync(path.join(REPO_ROOT, 'config.example.json'), 'utf8');
    expect(JSON.parse(raw)).toEqual(DEFAULT_CONFIG);
  });
});
