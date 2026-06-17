import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { HaltError } from '../runtime/halt.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import type { DeepPartial, OperatorConfig, Secrets } from './config.js';

const HOME_MODE = 0o700;
const SECRET_MODE = 0o600;
const LOOSER_THAN_SECRET = 0o077;
const HANDOFF_TTL_MS = 5 * 60 * 1000;
const HANDOFF_FILE = /^secrets-.*\.json$/;

export function configStorePath(home: string): string {
  return path.join(home, 'config.json');
}

export function secretsStorePath(home: string): string {
  return path.join(home, 'secrets.json');
}

export function handoffDir(home: string): string {
  return path.join(home, 'handoff');
}

export function ensureHandoffDir(home: string): string {
  ensureStoreHome(home);
  const dir = handoffDir(home);
  if (existsSync(dir)) {
    if ((statSync(dir).mode & LOOSER_THAN_SECRET) !== 0) {
      chmodSync(dir, HOME_MODE);
    }
    return dir;
  }
  mkdirSync(dir, { recursive: true, mode: HOME_MODE });
  chmodSync(dir, HOME_MODE);
  return dir;
}

// Lazy GC for the launch handoff. The child read-once-unlinks its own file and
// the parent removes it on a detected startup failure; a child that is alive at
// the liveness probe but dies before reading leaves an owner-only secret behind.
// Each detached launch sweeps handoff files older than the TTL — comfortably
// larger than the parent-write→child-read window, so a concurrent launch's
// freshly written, not-yet-read file is never collected. Unlinks are
// best-effort: the files are owner-only under <home>/handoff/.
export function sweepHandoffDir(home: string, maxAgeMs = HANDOFF_TTL_MS): void {
  const dir = handoffDir(home);
  if (!existsSync(dir)) {
    return;
  }
  const cutoff = Date.now() - maxAgeMs;
  for (const entry of readdirSync(dir)) {
    if (!HANDOFF_FILE.test(entry)) {
      continue;
    }
    const file = path.join(dir, entry);
    try {
      if (statSync(file).mtimeMs < cutoff) {
        unlinkSync(file);
      }
    } catch {
      /* best-effort: the file is owner-only under <home>/handoff/ */
    }
  }
}

// Owner-only home. Creates it 0700 when absent and re-hardens an existing home
// that a prior run created 0755 (run.ts mkdir uses the process umask), so the
// store directory is owner-only before any secret read or write (NFR-2). The
// re-harden is conditional on a looser-than-0700 mode: an already owner-only
// home is left untouched, so a home that a consumer has tightened further is
// not loosened and a no-op call does not spuriously chmod.
export function ensureStoreHome(home: string): void {
  if (existsSync(home)) {
    if ((statSync(home).mode & LOOSER_THAN_SECRET) !== 0) {
      chmodSync(home, HOME_MODE);
    }
    return;
  }
  mkdirSync(home, { recursive: true, mode: HOME_MODE });
  chmodSync(home, HOME_MODE);
}

// Two-step owner-only write mirroring the clarify broker's writeSecure: the
// mode option races the umask, the explicit chmod is authoritative. Reused by
// the detached-launch secret handoff (P5) so there is one secure-write path.
export function writeSecretFile(file: string, data: string): void {
  writeFileSync(file, data, { mode: SECRET_MODE });
  chmodSync(file, SECRET_MODE);
}

// A malformed store must never echo file contents: a leaked secrets.json would
// surface the bot token in an error message. The thrown HaltError names only the
// path.
function parseStoreFile(file: string, label: string): JsonObject {
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  } catch {
    throw new HaltError(`${label} is not valid JSON: ${file}`, 1);
  }
  if (!isJsonObject(parsed)) {
    throw new HaltError(`${label} must be a JSON object: ${file}`, 1);
  }
  return parsed;
}

// Missing store → empty defaults so an onboarding-free run still resolves from
// DEFAULT_CONFIG. Unknown extra keys are tolerated for a hand-edited or
// forward-compatible store; only invalid JSON or a non-object root halts.
export function readConfigStore(home: string): DeepPartial<OperatorConfig> {
  const file = configStorePath(home);
  if (!existsSync(file)) {
    return {};
  }
  return parseStoreFile(file, 'config.json');
}

// Operator overrides are intentionally partial: callers persist only the keys they
// set and let the rest resolve from defaults. The writer mirrors readConfigStore,
// which already returns a DeepPartial, rather than demanding a full OperatorConfig.
// This is the full-rewrite path; mergeConfigStore is the additive one.
export function writeConfigStore(home: string, config: DeepPartial<OperatorConfig>): void {
  ensureStoreHome(home);
  writeFileSync(configStorePath(home), `${JSON.stringify(config, null, 2)}\n`);
}

// New value wins for scalars, arrays, and type mismatches; recurse only when both
// sides are objects, so keys present only on the base survive. Arrays replace
// rather than concat because isJsonObject is false for them.
function deepMergeJson(base: JsonObject, patch: JsonObject): JsonObject {
  const out: JsonObject = { ...base };
  for (const [key, patchValue] of Object.entries(patch)) {
    const baseValue = out[key];
    out[key] =
      isJsonObject(baseValue) && isJsonObject(patchValue)
        ? deepMergeJson(baseValue, patchValue)
        : patchValue;
  }
  return out;
}

// Additive persistence so re-running init (token rotation, re-discovery) never
// discards operator-tuned or unknown keys: read the existing store, deep-merge the
// partial onto it, and write through the single full-rewrite path.
export function mergeConfigStore(home: string, patch: DeepPartial<OperatorConfig>): void {
  const existing = readConfigStore(home) as JsonObject;
  const merged = deepMergeJson(existing, patch as JsonObject);
  writeConfigStore(home, merged);
}

// Symmetric hardening: ensureStoreHome plus a read-time chmod of an existing
// secrets.json that is looser than 0600 (a hand-created 0644 file is repaired,
// not trusted). A missing store short-circuits before ensureStoreHome so a pure
// read against a home with no secret file (e.g. `agent-quorum config` pointed at
// a consumer's directory) never alters its permissions. A `telegramBotToken` of
// the wrong type halts without echoing the value.
export function readSecretsStore(home: string): Secrets {
  const file = secretsStorePath(home);
  if (!existsSync(file)) {
    return {};
  }
  ensureStoreHome(home);
  if ((statSync(file).mode & LOOSER_THAN_SECRET) !== 0) {
    chmodSync(file, SECRET_MODE);
  }
  const parsed = parseStoreFile(file, 'secrets.json');
  const token = parsed.telegramBotToken;
  if (token !== undefined && typeof token !== 'string') {
    throw new HaltError(`secrets.json: telegramBotToken must be a string: ${file}`, 1);
  }
  return token === undefined ? {} : { telegramBotToken: token };
}

export function writeSecretsStore(home: string, secrets: Secrets): void {
  ensureStoreHome(home);
  writeSecretFile(secretsStorePath(home), `${JSON.stringify(secrets, null, 2)}\n`);
}
