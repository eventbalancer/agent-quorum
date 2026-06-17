import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { HaltError } from '../runtime/halt.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import type { DeepPartial, OperatorConfig, Secrets } from './config.js';

const HOME_MODE = 0o700;
const SECRET_MODE = 0o600;
const LOOSER_THAN_SECRET = 0o077;

export function configStorePath(home: string): string {
  return path.join(home, 'config.json');
}

export function secretsStorePath(home: string): string {
  return path.join(home, 'secrets.json');
}

export function handoffDir(home: string): string {
  return path.join(home, 'handoff');
}

// Owner-only home. Creates it 0700 when absent and re-hardens an existing home
// that a prior run created 0755 (run.ts mkdir uses the process umask), so the
// store directory is owner-only before any secret read or write (NFR-2).
export function ensureStoreHome(home: string): void {
  if (existsSync(home)) {
    chmodSync(home, HOME_MODE);
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
export function writeConfigStore(home: string, config: DeepPartial<OperatorConfig>): void {
  ensureStoreHome(home);
  writeFileSync(configStorePath(home), `${JSON.stringify(config, null, 2)}\n`);
}

// Symmetric hardening: ensureStoreHome plus a read-time chmod of an existing
// secrets.json that is looser than 0600 (a hand-created 0644 file is repaired,
// not trusted). A `telegramBotToken` of the wrong type halts without echoing the
// value.
export function readSecretsStore(home: string): Secrets {
  ensureStoreHome(home);
  const file = secretsStorePath(home);
  if (!existsSync(file)) {
    return {};
  }
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
