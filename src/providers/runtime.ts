import type { RoleMatrix } from '../core/config.js';
import type { RetryPolicy } from '../runtime/retry.js';
import type { Scratch } from '../runtime/scratch.js';
import type { Role } from '../types.js';
import type { StreamKnobs } from './watchdog.js';

export interface ProviderRuntime {
  scratch: Scratch;
  projectRoot: string;
  retry: RetryPolicy;
  claudeKnobs: StreamKnobs;
  cursorKnobs: StreamKnobs;
  matrix: RoleMatrix;
  sessionMode: 0 | 1;
  creatorSessionFile: string;
  markdownSchemaPath: string;
  cursorBin: string;
  claudePermissionMode?: string;
}

// The session-capable combos are (creator, claude) and (creator, cursor) under
// SESSION_MODE; every other (role, runner) runs stateless.
export function roleSessionFile(rt: ProviderRuntime, role: Role): string {
  if (role !== 'creator' || rt.sessionMode !== 1) {
    return '';
  }
  const runner = rt.matrix.creator.runner;
  if (runner === 'claude' || runner === 'cursor') {
    return rt.creatorSessionFile;
  }
  return '';
}

export function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, '');
}
