import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';
import { RUNNERS } from '../providers/registry.js';
import type { Runner } from '../types.js';

// PATH probe shared by preflight (required-runner gate) and setup (auto-detect).
// Lives in core/ so both cli/ and stages/ can import it without a layer breach.
export function commandExists(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') {
      continue;
    }
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function detectInstalledRunners(binaries: Record<Runner, string>): readonly Runner[] {
  return RUNNERS.filter((runner) => {
    return commandExists(binaries[runner]);
  });
}
