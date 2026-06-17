import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let cachedPackageRoot: string | undefined;

// Both package.json and skills/ always ship together, so the pair pins the installed root.
export function findPackageRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'skills'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error('agent-quorum package root not found');
    }
    dir = parent;
  }
}

export function packageRoot(): string {
  if (cachedPackageRoot !== undefined) {
    return cachedPackageRoot;
  }
  cachedPackageRoot = findPackageRoot(path.dirname(fileURLToPath(import.meta.url)));
  return cachedPackageRoot;
}

export function resetPackageRootCache(): void {
  cachedPackageRoot = undefined;
}

// In-process replacement for `git rev-parse --show-toplevel || pwd`: walk up
// to the nearest directory containing .git, falling back to cwd.
export function projectRoot(cwd: string = process.cwd()): string {
  let dir = cwd;
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      return cwd;
    }
    dir = parent;
  }
}
