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

// Sweeps handoff files older than the TTL, covering a child that dies after the
// liveness probe but before reading. The TTL exceeds the write→read window, so a
// concurrent launch's fresh file is never collected.
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

// Re-hardens a home a prior run created 0755 under the process umask, but only when
// looser than 0700 so a tighter home is never loosened.
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

// The mode option races the umask, so the explicit chmod is authoritative.
export function writeSecretFile(file: string, data: string): void {
  writeFileSync(file, data, { mode: SECRET_MODE });
  chmodSync(file, SECRET_MODE);
}

// Never echo file contents: a malformed secrets.json must not surface the token in the
// error, so the HaltError names only the path.
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

// Missing store → empty defaults; unknown keys are tolerated, only invalid JSON or a
// non-object root halts.
export function readConfigStore(home: string): DeepPartial<OperatorConfig> {
  const file = configStorePath(home);
  if (!existsSync(file)) {
    return {};
  }
  return parseStoreFile(file, 'config.json');
}

// Full-rewrite path (mergeConfigStore is the additive one); the store is intentionally
// partial, so callers persist only the keys they set.
export function writeConfigStore(home: string, config: DeepPartial<OperatorConfig>): void {
  ensureStoreHome(home);
  writeFileSync(configStorePath(home), `${JSON.stringify(config, null, 2)}\n`);
}

// Recurse only when both sides are objects, so base-only keys survive; arrays replace
// rather than concat.
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

// Additive so re-running init never discards operator-tuned or unknown keys.
export function mergeConfigStore(home: string, patch: DeepPartial<OperatorConfig>): void {
  const existing = readConfigStore(home) as JsonObject;
  const merged = deepMergeJson(existing, patch as JsonObject);
  writeConfigStore(home, merged);
}

// Read-time hardening repairs an existing secrets.json looser than 0600. A missing
// store short-circuits before ensureStoreHome so a pure read never alters permissions.
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
