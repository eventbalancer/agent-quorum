import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedPackageRoot: string | undefined;

export function packageRoot(): string {
  if (cachedPackageRoot !== undefined) return cachedPackageRoot;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (;;) {
    if (
      existsSync(path.join(dir, 'plan-loop.json')) &&
      existsSync(path.join(dir, 'package.json'))
    ) {
      cachedPackageRoot = dir;
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error('plan-loop package root not found');
    dir = parent;
  }
}

// In-process replacement for `git rev-parse --show-toplevel || pwd`: walk up
// to the nearest directory containing .git, falling back to cwd.
export function projectRoot(cwd: string = process.cwd()): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return cwd;
    dir = parent;
  }
}

const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Mirrors the reference loader: real environment variables win (an empty
// string counts as unset), quotes are stripped one layer per kind, and the
// file is read only from the package root — never from the directory of a
// PLAN_LOOP_CONFIG_FILE override.
export function loadPlanLoopDotenv(root: string = packageRoot()): void {
  const file = path.join(root, '.env');
  if (!existsSync(file)) return;
  for (const rawLine of readFileSync(file, 'utf8').split('\n')) {
    let line = rawLine.replace(/\r$/, '');
    if (/^[ \t\n\v\f\r]*#/.test(line)) continue;
    if (/^[ \t\n\v\f\r]*$/.test(line)) continue;
    if (line.startsWith('export ')) line = line.slice('export '.length);
    const eq = line.indexOf('=');
    const rawKey = eq === -1 ? line : line.slice(0, eq);
    let val = eq === -1 ? line : line.slice(eq + 1);
    const key = rawKey.replace(/[ \t\n\v\f\r]+/g, '');
    if (!KEY_PATTERN.test(key)) continue;
    if (val.startsWith('"')) val = val.slice(1);
    if (val.endsWith('"')) val = val.slice(0, -1);
    if (val.startsWith("'")) val = val.slice(1);
    if (val.endsWith("'")) val = val.slice(0, -1);
    const existing = process.env[key];
    if (existing === undefined || existing === '') process.env[key] = val;
  }
}
