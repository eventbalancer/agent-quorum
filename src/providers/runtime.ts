import type { RoleMatrix } from '../core/config.js';
import type { RetryPolicy } from '../runtime/retry.js';
import type { Scratch } from '../runtime/scratch.js';
import type { Role, Runner } from '../types.js';
import { RUNNER_META } from './registry.js';
import type { StreamKnobs } from './watchdog.js';

export interface ProviderRuntime {
  readonly scratch: Scratch;
  readonly projectRoot: string;
  readonly retry: RetryPolicy;
  readonly streamKnobs: Record<Runner, StreamKnobs>;
  readonly matrix: RoleMatrix;
  readonly sessionMode: 0 | 1;
  readonly creatorSessionFile: string;
  readonly markdownSchemaPath: string;
  readonly binaries: Record<Runner, string>;
  readonly claudePermissionMode?: string;
  // Opt-in raw-diagnostics directory. Unset means raw stderr/stdout is dropped
  // after classification (default-off).
  readonly diagnosticsDir?: string;
}

export function roleSessionFile(providerRuntime: ProviderRuntime, role: Role): string {
  if (role !== 'creator' || providerRuntime.sessionMode !== 1) {
    return '';
  }
  const runner = providerRuntime.matrix.creator.runner;
  if (RUNNER_META[runner].usesSession) {
    return providerRuntime.creatorSessionFile;
  }
  return '';
}

export function stripTrailingNewlines(text: string): string {
  return text.replace(/\n+$/, '');
}

// In -p capture every claude role's result IS the artifact, so the default is
// "default", not "plan" (plan mode makes weak models present a stub and persist
// the real plan to ~/.claude/plans/). Precedence: runtime override > env > default.
export function resolveClaudePermissionMode(providerRuntime: ProviderRuntime): string {
  return providerRuntime.claudePermissionMode ?? process.env.CLAUDE_PERMISSION_MODE ?? 'default';
}
