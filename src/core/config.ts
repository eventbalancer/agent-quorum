import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { packageRoot } from '../runtime/env.js';
import { HaltError } from '../runtime/halt.js';
import { err, log } from '../runtime/log.js';
import { RUNNERS, isRunner } from '../providers/registry.js';
import type { Role, Runner } from '../types.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';

const PLAN_ROLES: readonly Role[] = ['critic', 'creator', 'fixer', 'reviewer', 'translator'];
const SETTINGS_KEYS = [
  'iters',
  'effort',
  'fix',
  'translate',
  'locale',
  'diffThreshold',
  'retryCount',
  'retryDelaySeconds',
];
const ROLE_FIELD_KEYS = [
  'runner',
  'model',
  'reasoning',
  'tools',
  'disallowedTools',
  'createTools',
  'createDisallowedTools',
  'updateTools',
  'updateDisallowedTools',
];

export interface RoleMatrixEntry {
  runner: Runner;
  model: string;
  reasoning: string;
}

export type RoleMatrix = Record<Role, RoleMatrixEntry>;

export interface RoleTools {
  tools: string;
  disallowedTools: string;
}

export interface CreatorTools {
  createTools: string;
  createDisallowedTools: string;
  updateTools: string;
  updateDisallowedTools: string;
}

export interface RolePermissions {
  critic: RoleTools;
  reviewer: RoleTools;
  fixer: RoleTools;
  creator: CreatorTools;
  translator: RoleTools;
}

export interface CliSettings {
  maxIters?: string;
  effort?: string;
  fix?: string;
  translate?: string;
  locale?: string;
}

export interface RunSettings {
  maxIters: number;
  effort: string;
  fixPass: 0 | 1;
  translatePass: 0 | 1;
  locale: string;
  diffThreshold: number;
  retryCount: number;
  retryDelaySeconds: number;
}

function halt(message: string): never {
  err(message);
  throw new HaltError(message, 1, true);
}

export function configFilePath(): string {
  const override = process.env.AGENT_QUORUM_CONFIG_FILE;
  if (override) {
    return override;
  }
  return path.join(packageRoot(), 'agent-quorum.json');
}

let validatedFile: string | undefined;
let validatedConfig: JsonObject | undefined;

export function resetConfigCache(): void {
  validatedFile = undefined;
  validatedConfig = undefined;
}

function configWarnUnknown(config: JsonObject): void {
  for (const key of Object.keys(config).sort()) {
    if (key === 'version' || key === 'roles' || key === 'settings') {
      continue;
    }
    log(`WARNING: agent-quorum.json ignoring unknown top-level key '${key}'`);
  }
  const settings = config.settings;
  if (isJsonObject(settings)) {
    for (const key of Object.keys(settings).sort()) {
      if (SETTINGS_KEYS.includes(key)) {
        continue;
      }
      log(`WARNING: agent-quorum.json ignoring unknown setting '${key}'`);
    }
  }
  const roles = config.roles;
  if (isJsonObject(roles)) {
    for (const key of Object.keys(roles).sort()) {
      if ((PLAN_ROLES as readonly string[]).includes(key)) {
        continue;
      }
      log(`WARNING: agent-quorum.json ignoring unknown role '${key}'`);
    }
    for (const role of PLAN_ROLES) {
      const roleConfig = roles[role];
      if (!isJsonObject(roleConfig)) {
        continue;
      }
      for (const key of Object.keys(roleConfig).sort()) {
        if (ROLE_FIELD_KEYS.includes(key)) {
          continue;
        }
        log(`WARNING: agent-quorum.json ignoring unknown field '${role}.${key}'`);
      }
    }
  }
}

function isValidToolField(value: JsonValue | undefined): boolean {
  if (typeof value === 'string') {
    return value.length > 0;
  }
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((item) => typeof item === 'string' && item.length > 0);
  }
  return false;
}

function roleField(config: JsonObject, role: string, field: string): JsonValue | undefined {
  const roles = config.roles;
  if (!isJsonObject(roles)) {
    return undefined;
  }
  const roleConfig = roles[role];
  if (!isJsonObject(roleConfig)) {
    return undefined;
  }
  return roleConfig[field];
}

export function validateAgentQuorumConfig(file: string): JsonObject {
  if (validatedFile === file && validatedConfig !== undefined) {
    return validatedConfig;
  }
  if (!existsSync(file)) {
    halt(`agent-quorum config: file not found: ${file}`);
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
  } catch {
    halt(`agent-quorum.json is not valid JSON: ${file}`);
  }
  const config: JsonObject = isJsonObject(parsed) ? parsed : {};

  configWarnUnknown(config);
  if (!('version' in config)) {
    halt('agent-quorum config: missing required field version');
  }
  if (!isJsonObject(config.settings)) {
    halt('agent-quorum config: missing required object settings');
  }
  if (!isJsonObject(config.roles)) {
    halt('agent-quorum config: missing required object roles');
  }

  for (const field of [
    'iters',
    'effort',
    'fix',
    'diffThreshold',
    'retryCount',
    'retryDelaySeconds',
  ]) {
    if (!(field in config.settings)) {
      halt(`agent-quorum config: missing required field settings.${field}`);
    }
  }

  for (const role of PLAN_ROLES) {
    if (!isJsonObject(config.roles[role])) {
      halt(`agent-quorum config: missing required object roles.${role}`);
    }
    for (const field of ['runner', 'model', 'reasoning']) {
      const value = roleField(config, role, field);
      if (typeof value !== 'string' || value.length === 0) {
        halt(`agent-quorum config: missing required field roles.${role}.${field}`);
      }
    }
  }

  for (const role of ['critic', 'fixer', 'reviewer', 'translator']) {
    for (const field of ['tools', 'disallowedTools']) {
      if (!isValidToolField(roleField(config, role, field))) {
        halt(
          `agent-quorum config: missing required field roles.${role}.${field} (string or non-empty string array)`,
        );
      }
    }
  }
  for (const field of [
    'createTools',
    'createDisallowedTools',
    'updateTools',
    'updateDisallowedTools',
  ]) {
    if (!isValidToolField(roleField(config, 'creator', field))) {
      halt(
        `agent-quorum config: missing required field roles.creator.${field} (string or non-empty string array)`,
      );
    }
  }

  validatedFile = file;
  validatedConfig = config;
  return config;
}

// jq -r rendering of a settings value: strings pass through, scalars print,
// null/absent resolve to empty (treated as missing by the precedence chain).
function configFileSetting(config: JsonObject, key: string): string {
  const settings = config.settings;
  if (!isJsonObject(settings)) {
    return '';
  }
  const value = settings[key];
  if (value === null || value === undefined) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value, null, 2);
}

function resolveSetting(
  cli: string | undefined,
  envName: string | undefined,
  key: string,
  config: JsonObject,
): string {
  if (cli) {
    return cli;
  }
  if (envName) {
    const envVal = process.env[envName];
    if (envVal) {
      return envVal;
    }
  }
  const fileVal = configFileSetting(config, key);
  if (fileVal) {
    return fileVal;
  }
  halt(`agent-quorum config: missing required setting settings.${key}`);
}

function parseBooleanSetting(raw: string, key: string): 0 | 1 {
  if (raw === 'true' || raw === '1' || raw === 'on' || raw === 'yes') {
    return 1;
  }
  if (raw === 'false' || raw === '0' || raw === 'off' || raw === 'no') {
    return 0;
  }
  halt(`agent-quorum config: settings.${key} must be true or false (got '${raw}')`);
}

// Default locale when nothing requests one: operator interaction and the
// companion plan stay in English and no translate pass runs.
const DEFAULT_LOCALE = 'en';
// Back-compat: a bare --translate / settings.translate with no explicit locale
// still produces the Russian companion plan the tool historically emitted.
const LEGACY_TRANSLATE_LOCALE = 'ru';

function normalizeLocale(raw: string): string {
  const locale = raw.trim();
  if (locale === '') {
    return '';
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(locale)) {
    halt(`agent-quorum config: settings.locale must be a locale tag (got '${raw}')`);
  }
  return locale;
}

function localeNeedsTranslation(locale: string): boolean {
  return !/^en([._-]|$)/i.test(locale);
}

interface ResolvedLocales {
  cliLocale: string;
  envLocale: string;
  fileLocale: string;
}

// Translate-pass precedence: an explicit --translate / AGENT_QUORUM_TRANSLATE /
// settings.translate toggle wins at its level; otherwise a requested locale
// implies the pass unless it is English. cli > env > file throughout.
function resolveTranslatePass(
  cli: CliSettings,
  config: JsonObject,
  locales: ResolvedLocales,
): 0 | 1 {
  if (cli.translate !== undefined) {
    return parseBooleanSetting(cli.translate, 'translate');
  }
  if (locales.cliLocale !== '') {
    return localeNeedsTranslation(locales.cliLocale) ? 1 : 0;
  }
  const envTranslate = process.env.AGENT_QUORUM_TRANSLATE ?? '';
  if (envTranslate !== '') {
    return parseBooleanSetting(envTranslate, 'translate');
  }
  if (locales.envLocale !== '') {
    return localeNeedsTranslation(locales.envLocale) ? 1 : 0;
  }
  const fileTranslate = configFileSetting(config, 'translate');
  if (fileTranslate !== '') {
    return parseBooleanSetting(fileTranslate, 'translate');
  }
  return locales.fileLocale !== '' && localeNeedsTranslation(locales.fileLocale) ? 1 : 0;
}

export function resolveRunSettings(cli: CliSettings, file: string = configFilePath()): RunSettings {
  const config = validateAgentQuorumConfig(file);

  const maxIters = resolveSetting(cli.maxIters, 'AGENT_QUORUM_MAX_ITERS', 'iters', config);
  const effort = resolveSetting(cli.effort, undefined, 'effort', config);
  const diffThreshold = resolveSetting(
    undefined,
    'AGENT_QUORUM_DIFF_THRESHOLD',
    'diffThreshold',
    config,
  );
  const retryCount = resolveSetting(undefined, 'AGENT_QUORUM_RETRY_COUNT', 'retryCount', config);
  const retryDelaySeconds = resolveSetting(
    undefined,
    'AGENT_QUORUM_RETRY_DELAY_SECONDS',
    'retryDelaySeconds',
    config,
  );

  const fixPass = parseBooleanSetting(resolveSetting(cli.fix, undefined, 'fix', config), 'fix');
  const cliLocale = normalizeLocale(cli.locale ?? '');
  const envLocale = normalizeLocale(process.env.AGENT_QUORUM_LOCALE ?? '');
  const fileLocale = normalizeLocale(configFileSetting(config, 'locale'));
  const requestedLocale = cliLocale || envLocale || fileLocale;
  const translatePass = resolveTranslatePass(cli, config, { cliLocale, envLocale, fileLocale });
  const usesLegacyRussianDefault = translatePass === 1 && requestedLocale === '';
  const locale = usesLegacyRussianDefault
    ? LEGACY_TRANSLATE_LOCALE
    : requestedLocale || DEFAULT_LOCALE;

  if (!/^[0-9]+$/.test(maxIters) || Number(maxIters) <= 0) {
    halt(`agent-quorum config: iters must be a positive integer (got '${maxIters}')`);
  }
  if (!/^[0-9]+$/.test(diffThreshold)) {
    halt(
      `agent-quorum config: diffThreshold must be a non-negative integer (got '${diffThreshold}')`,
    );
  }
  if (!/^[0-9]+$/.test(retryCount)) {
    halt(`agent-quorum config: retryCount must be a non-negative integer (got '${retryCount}')`);
  }
  if (!/^[0-9]+$/.test(retryDelaySeconds)) {
    halt(
      `agent-quorum config: retryDelaySeconds must be a non-negative integer (got '${retryDelaySeconds}')`,
    );
  }

  return {
    maxIters: Number(maxIters),
    effort,
    fixPass,
    translatePass,
    locale,
    diffThreshold: Number(diffThreshold),
    retryCount: Number(retryCount),
    retryDelaySeconds: Number(retryDelaySeconds),
  };
}

function configFileValue(config: JsonObject, role: string, field: string): string {
  const value = roleField(config, role, field);
  if (typeof value === 'string') {
    return value;
  }
  return '';
}

export function resolveRoleConfig(file: string = configFilePath()): RoleMatrix {
  const config = validateAgentQuorumConfig(file);
  const matrix: Partial<RoleMatrix> = {};
  for (const role of PLAN_ROLES) {
    const upper = role.toUpperCase();
    const envRunner = process.env[`AGENT_QUORUM_${upper}_RUNNER`];
    const runner =
      envRunner !== undefined && envRunner !== ''
        ? envRunner
        : configFileValue(config, role, 'runner');
    if (!isRunner(runner)) {
      halt(
        `agent-quorum config: role '${role}' has invalid runner '${runner}' (expected ${RUNNERS.join(', ')})`,
      );
    }
    const envModel = process.env[`AGENT_QUORUM_${upper}_MODEL`];
    const model =
      envModel !== undefined && envModel !== '' ? envModel : configFileValue(config, role, 'model');
    const envReasoning = process.env[`AGENT_QUORUM_${upper}_REASONING`];
    const reasoning =
      envReasoning !== undefined && envReasoning !== ''
        ? envReasoning
        : configFileValue(config, role, 'reasoning');
    matrix[role] = { runner, model, reasoning };
  }
  const full = matrix as RoleMatrix;
  log('config: effective role matrix (env > agent-quorum.json):');
  for (const role of PLAN_ROLES) {
    const entry = full[role];
    log(`  → ${role}: runner=${entry.runner} model=${entry.model} reasoning=${entry.reasoning}`);
  }
  return full;
}

function resolveToolConfigValue(config: JsonObject, role: string, field: string): string {
  const value = roleField(config, role, field);
  let rendered: string;
  if (value === null || value === undefined) {
    rendered = '';
  } else if (Array.isArray(value)) {
    rendered = value.map((item) => (typeof item === 'string' ? item : '')).join(',');
  } else if (typeof value === 'string') {
    rendered = value;
  } else {
    halt(`agent-quorum config: role '${role}' ${field} must be a string or array`);
  }
  if (rendered === '') {
    halt(`agent-quorum config: role '${role}' ${field} is required and must be non-empty`);
  }
  return rendered;
}

export function resolveRolePermissions(file: string = configFilePath()): RolePermissions {
  const config = validateAgentQuorumConfig(file);

  const critic: RoleTools = {
    tools: resolveToolConfigValue(config, 'critic', 'tools'),
    disallowedTools: resolveToolConfigValue(config, 'critic', 'disallowedTools'),
  };
  const reviewer: RoleTools = {
    tools: resolveToolConfigValue(config, 'reviewer', 'tools'),
    disallowedTools: resolveToolConfigValue(config, 'reviewer', 'disallowedTools'),
  };
  const fixer: RoleTools = {
    tools: resolveToolConfigValue(config, 'fixer', 'tools'),
    disallowedTools: resolveToolConfigValue(config, 'fixer', 'disallowedTools'),
  };
  const creator: CreatorTools = {
    createTools: resolveToolConfigValue(config, 'creator', 'createTools'),
    createDisallowedTools: resolveToolConfigValue(config, 'creator', 'createDisallowedTools'),
    updateTools: resolveToolConfigValue(config, 'creator', 'updateTools'),
    updateDisallowedTools: resolveToolConfigValue(config, 'creator', 'updateDisallowedTools'),
  };
  const translator: RoleTools = {
    tools: resolveToolConfigValue(config, 'translator', 'tools'),
    disallowedTools: resolveToolConfigValue(config, 'translator', 'disallowedTools'),
  };

  log('config: effective tool permissions:');
  log(`  → critic: tools=${critic.tools} disallowed=${critic.disallowedTools}`);
  log(
    `  → creator.create: tools=${creator.createTools} disallowed=${creator.createDisallowedTools}`,
  );
  log(
    `  → creator.update: tools=${creator.updateTools} disallowed=${creator.updateDisallowedTools}`,
  );
  log(`  → fixer: tools=${fixer.tools} disallowed=${fixer.disallowedTools}`);
  log(`  → reviewer: tools=${reviewer.tools} disallowed=${reviewer.disallowedTools}`);
  log(`  → translator: tools=${translator.tools} disallowed=${translator.disallowedTools}`);

  return { critic, reviewer, fixer, creator, translator };
}

export function runnersInUse(matrix: RoleMatrix, fixPass: 0 | 1, translatePass: 0 | 1): Runner[] {
  const roles: Role[] = ['critic', 'creator'];
  if (fixPass === 1) {
    roles.push('fixer', 'reviewer');
  }
  if (translatePass === 1) {
    roles.push('translator');
  }
  const seen = new Set(roles.map((role) => matrix[role].runner));
  return RUNNERS.filter((runner) => seen.has(runner));
}
