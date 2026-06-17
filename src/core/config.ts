import os from 'node:os';
import { HaltError } from '../runtime/halt.js';
import { err, log } from '../runtime/log.js';
import { RUNNERS, isRunner } from '../providers/registry.js';
import type { Role, Runner } from '../types.js';
import { DEFAULT_CONFIG } from './defaults.js';
import type { SplitMode } from './split-policy.js';
import { readConfigStore, readSecretsStore } from './store.js';

const PLAN_ROLES: readonly Role[] = ['critic', 'creator', 'fixer', 'reviewer', 'translator'];

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

// The three resolve* functions are thin projections of one ResolvedConfig from
// resolveConfig; run.ts resolves once and threads the result. The role-matrix and
// tool-permission projections keep the effective-configuration log lines.
export function resolveRunSettings(resolved: ResolvedConfig): RunSettings {
  return resolved.settings;
}

export function resolveRoleConfig(resolved: ResolvedConfig): RoleMatrix {
  const matrix = resolved.matrix;
  log('config: effective role matrix (override > env > store > default):');
  for (const role of PLAN_ROLES) {
    const entry = matrix[role];
    log(`  → ${role}: runner=${entry.runner} model=${entry.model} reasoning=${entry.reasoning}`);
  }
  return matrix;
}

export function resolveRolePermissions(resolved: ResolvedConfig): RolePermissions {
  const permissions = resolved.permissions;
  log('config: effective tool permissions:');
  log(
    `  → critic: tools=${permissions.critic.tools} disallowed=${permissions.critic.disallowedTools}`,
  );
  log(
    `  → creator.create: tools=${permissions.creator.createTools} disallowed=${permissions.creator.createDisallowedTools}`,
  );
  log(
    `  → creator.update: tools=${permissions.creator.updateTools} disallowed=${permissions.creator.updateDisallowedTools}`,
  );
  log(
    `  → fixer: tools=${permissions.fixer.tools} disallowed=${permissions.fixer.disallowedTools}`,
  );
  log(
    `  → reviewer: tools=${permissions.reviewer.tools} disallowed=${permissions.reviewer.disallowedTools}`,
  );
  log(
    `  → translator: tools=${permissions.translator.tools} disallowed=${permissions.translator.disallowedTools}`,
  );
  return permissions;
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

// ---------------------------------------------------------------------------
// Unified configuration store: OperatorConfig (persistable), ResolvedConfig
// (runtime scalars), and resolveConfig (single layered resolver + provenance).
// ---------------------------------------------------------------------------

export type DeepPartial<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]?: DeepPartial<T[K]> }
    : T;

export type ToolField = string | readonly string[];

export interface OperatorSettings {
  iters: number;
  effort: string;
  fix: boolean;
  translate: boolean;
  locale: string;
  diffThreshold: number;
  retryCount: number;
  retryDelaySeconds: number;
}

export interface OperatorRole {
  runner: Runner;
  model: string;
  reasoning: string;
  tools?: ToolField;
  disallowedTools?: ToolField;
  createTools?: ToolField;
  createDisallowedTools?: ToolField;
  updateTools?: ToolField;
  updateDisallowedTools?: ToolField;
}

export type OperatorRoles = Record<Role, OperatorRole>;

export interface OperatorStreamKnobs {
  stallTimeoutSeconds: number;
  stallPollSeconds: number;
  stallInterruptGraceSeconds: number;
  callTimeoutSeconds: number;
  semanticIdleTimeoutSeconds: number;
}

export interface OperatorPassKnobs {
  timeoutSeconds: number;
  semanticIdleTimeoutSeconds: number;
  retryCount: number;
}

export interface OperatorKnobs {
  claude: OperatorStreamKnobs;
  cursor: OperatorStreamKnobs;
  fixPass: OperatorPassKnobs;
  translatePass: OperatorPassKnobs;
}

export interface OperatorSplit {
  mode: SplitMode;
  minPhases: number;
}

export interface OperatorRetention {
  keepCount: number;
  maxAgeDays: number;
}

export interface OperatorTelegram {
  chatId: string;
  clarify: string;
  clarifyDeadlineSeconds: number;
  pollTimeoutSeconds: number;
  httpTimeoutSeconds: number;
  receiveFailureWindowSeconds: number;
  receiveBackoffSeconds: number;
}

export interface OperatorProviders {
  livenessHeartbeatSeconds: number;
  claudeThinkingEvery: number;
  cursorBin: string;
  providerDiagnostics: boolean;
}

export interface OperatorStatus {
  maxPlanLines: number;
}

export interface OperatorConfig {
  version?: number;
  settings: OperatorSettings;
  roles: OperatorRoles;
  knobs: OperatorKnobs;
  split: OperatorSplit;
  retention: OperatorRetention;
  telegram: OperatorTelegram;
  providers: OperatorProviders;
  status: OperatorStatus;
  claudePermissionMode: string;
}

export interface Secrets {
  telegramBotToken?: string;
}

export interface ResolvedStreamKnobs {
  byteTimeoutSeconds: number;
  pollSeconds: number;
  graceSeconds: number;
  wallTimeoutSeconds: number;
  semanticTimeoutSeconds: number;
}

export interface ResolvedKnobs {
  claude: ResolvedStreamKnobs;
  cursor: ResolvedStreamKnobs;
  fixPass: OperatorPassKnobs;
  translatePass: OperatorPassKnobs;
}

export interface ResolvedTelegram {
  botToken: string;
  chatId: string;
  apiBase: string;
  stateDir: string;
  clarify: string;
  clarifyDeadlineSeconds: number;
  pollTimeoutSeconds: number;
  httpTimeoutSeconds: number;
  receiveFailureWindowSeconds: number;
  receiveBackoffSeconds: number;
}

export interface ResolvedProviders {
  livenessHeartbeatSeconds: number;
  claudeThinkingEvery: number;
  cursorBin: string;
  providerDiagnostics: boolean;
  claudePermissionMode: string;
}

export interface ResolvedConfig {
  settings: RunSettings;
  matrix: RoleMatrix;
  permissions: RolePermissions;
  knobs: ResolvedKnobs;
  split: OperatorSplit;
  retention: OperatorRetention;
  telegram: ResolvedTelegram;
  providers: ResolvedProviders;
  status: OperatorStatus;
}

export type ConfigLayer = 'override' | 'env' | 'store' | 'default';

export interface ResolveOverrides {
  cli?: CliSettings;
  config?: DeepPartial<OperatorConfig>;
  secrets?: Secrets;
}

export interface ResolveConfigInput {
  overrides?: ResolveOverrides;
  env?: NodeJS.ProcessEnv;
  home: string;
}

export interface ResolvedConfigResult {
  config: ResolvedConfig;
  provenance: Map<string, ConfigLayer>;
}

type Raw = string | undefined;
type Candidate = readonly [ConfigLayer, Raw];

function present(raw: Raw): raw is string {
  return raw !== undefined && raw !== '';
}

function rawScalar(value: string | number | boolean | null | undefined): Raw {
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === 'string' ? value : String(value);
}

function rawToolField(value: ToolField | null | undefined): Raw {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === 'string' ? item : '')).join(',');
  }
  return typeof value === 'string' ? value : undefined;
}

function truthyFlag(raw: string): boolean {
  return raw === '1' || raw === 'true' || raw === 'on' || raw === 'yes';
}

// First present candidate wins; the default layer (last) is always present, so a
// resolved scalar always has a provenance entry.
function selectRaw(
  prov: Map<string, ConfigLayer>,
  pathKey: string,
  candidates: readonly Candidate[],
): string {
  for (const [layer, raw] of candidates) {
    if (present(raw)) {
      prov.set(pathKey, layer);
      return raw;
    }
  }
  prov.set(pathKey, 'default');
  return '';
}

function requireNonNegativeInt(raw: string, label: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    halt(`agent-quorum config: ${label} must be a non-negative integer (got '${raw}')`);
  }
  return Number(raw);
}

function resolveInt(
  prov: Map<string, ConfigLayer>,
  pathKey: string,
  candidates: readonly Candidate[],
  label: string,
): number {
  return requireNonNegativeInt(selectRaw(prov, pathKey, candidates), label);
}

function resolveStr(
  prov: Map<string, ConfigLayer>,
  pathKey: string,
  candidates: readonly Candidate[],
): string {
  return selectRaw(prov, pathKey, candidates);
}

function overrideThenStore(
  overrideRaw: Raw,
  envRaw: Raw,
  storeRaw: Raw,
  defaultRaw: Raw,
): readonly Candidate[] {
  return [
    ['override', overrideRaw],
    ['env', envRaw],
    ['store', storeRaw],
    ['default', defaultRaw],
  ];
}

function resolveSettings(
  prov: Map<string, ConfigLayer>,
  cli: CliSettings,
  ov: DeepPartial<OperatorSettings> | undefined,
  store: DeepPartial<OperatorSettings> | undefined,
  env: NodeJS.ProcessEnv,
  def: OperatorSettings,
): RunSettings {
  // The override tier resolves a top-level scalar flag (parsed.cli) ahead of the
  // same path in structured config — the explicit per-invocation flag is the more
  // specific operator intent.
  const overrideRaw = (cliRaw: Raw, ovRaw: Raw): Raw => (present(cliRaw) ? cliRaw : ovRaw);

  const maxItersRaw = selectRaw(
    prov,
    'settings.iters',
    overrideThenStore(
      overrideRaw(cli.maxIters, rawScalar(ov?.iters)),
      env.AGENT_QUORUM_MAX_ITERS,
      rawScalar(store?.iters),
      rawScalar(def.iters),
    ),
  );
  if (!/^[0-9]+$/.test(maxItersRaw) || Number(maxItersRaw) <= 0) {
    halt(`agent-quorum config: iters must be a positive integer (got '${maxItersRaw}')`);
  }

  const effort = resolveStr(
    prov,
    'settings.effort',
    overrideThenStore(
      overrideRaw(cli.effort, rawScalar(ov?.effort)),
      undefined,
      rawScalar(store?.effort),
      rawScalar(def.effort),
    ),
  );

  const fixPass = parseBooleanSetting(
    selectRaw(
      prov,
      'settings.fix',
      overrideThenStore(
        overrideRaw(cli.fix, rawScalar(ov?.fix)),
        undefined,
        rawScalar(store?.fix),
        rawScalar(def.fix),
      ),
    ),
    'fix',
  );

  const diffThreshold = resolveInt(
    prov,
    'settings.diffThreshold',
    overrideThenStore(
      rawScalar(ov?.diffThreshold),
      env.AGENT_QUORUM_DIFF_THRESHOLD,
      rawScalar(store?.diffThreshold),
      rawScalar(def.diffThreshold),
    ),
    'diffThreshold',
  );
  const retryCount = resolveInt(
    prov,
    'settings.retryCount',
    overrideThenStore(
      rawScalar(ov?.retryCount),
      env.AGENT_QUORUM_RETRY_COUNT,
      rawScalar(store?.retryCount),
      rawScalar(def.retryCount),
    ),
    'retryCount',
  );
  const retryDelaySeconds = resolveInt(
    prov,
    'settings.retryDelaySeconds',
    overrideThenStore(
      rawScalar(ov?.retryDelaySeconds),
      env.AGENT_QUORUM_RETRY_DELAY_SECONDS,
      rawScalar(store?.retryDelaySeconds),
      rawScalar(def.retryDelaySeconds),
    ),
    'retryDelaySeconds',
  );

  // Locale/translate keep the legacy precedence: an explicit translate toggle
  // wins at its tier; otherwise a non-English locale implies the pass. cli/config
  // (override) > env > store throughout, with cli ahead of structured config.
  const cliLocale = normalizeLocale(
    present(cli.locale) ? cli.locale : (rawScalar(ov?.locale) ?? ''),
  );
  const envLocale = normalizeLocale(env.AGENT_QUORUM_LOCALE ?? '');
  const storeLocale = normalizeLocale(rawScalar(store?.locale) ?? '');
  const overrideTranslate = present(cli.translate) ? cli.translate : rawScalar(ov?.translate);
  const envTranslate = env.AGENT_QUORUM_TRANSLATE ?? '';
  const storeTranslate = rawScalar(store?.translate);

  const translate = resolveLayeredTranslate(prov, {
    overrideTranslate,
    cliLocale,
    envTranslate,
    envLocale,
    storeTranslate,
    storeLocale,
    defaultTranslate: def.translate,
  });

  const requestedLocale = cliLocale || envLocale || storeLocale;
  prov.set(
    'settings.locale',
    cliLocale ? 'override' : envLocale ? 'env' : storeLocale ? 'store' : 'default',
  );
  const usesLegacyRussianDefault = translate === 1 && requestedLocale === '';
  const locale = usesLegacyRussianDefault
    ? LEGACY_TRANSLATE_LOCALE
    : requestedLocale || DEFAULT_LOCALE;

  return {
    maxIters: Number(maxItersRaw),
    effort,
    fixPass,
    translatePass: translate,
    locale,
    diffThreshold,
    retryCount,
    retryDelaySeconds,
  };
}

interface LayeredTranslate {
  overrideTranslate: Raw;
  cliLocale: string;
  envTranslate: string;
  envLocale: string;
  storeTranslate: Raw;
  storeLocale: string;
  defaultTranslate: boolean;
}

function resolveLayeredTranslate(prov: Map<string, ConfigLayer>, layers: LayeredTranslate): 0 | 1 {
  if (present(layers.overrideTranslate)) {
    prov.set('settings.translate', 'override');
    return parseBooleanSetting(layers.overrideTranslate, 'translate');
  }
  if (layers.cliLocale !== '') {
    prov.set('settings.translate', 'override');
    return localeNeedsTranslation(layers.cliLocale) ? 1 : 0;
  }
  if (layers.envTranslate !== '') {
    prov.set('settings.translate', 'env');
    return parseBooleanSetting(layers.envTranslate, 'translate');
  }
  if (layers.envLocale !== '') {
    prov.set('settings.translate', 'env');
    return localeNeedsTranslation(layers.envLocale) ? 1 : 0;
  }
  if (present(layers.storeTranslate)) {
    prov.set('settings.translate', 'store');
    return parseBooleanSetting(layers.storeTranslate, 'translate');
  }
  if (layers.storeLocale !== '') {
    prov.set('settings.translate', 'store');
    return localeNeedsTranslation(layers.storeLocale) ? 1 : 0;
  }
  prov.set('settings.translate', 'default');
  return layers.defaultTranslate ? 1 : 0;
}

function resolveMatrix(
  prov: Map<string, ConfigLayer>,
  ov: DeepPartial<OperatorRoles> | undefined,
  store: DeepPartial<OperatorRoles> | undefined,
  env: NodeJS.ProcessEnv,
  def: OperatorRoles,
): RoleMatrix {
  const matrix: Partial<RoleMatrix> = {};
  for (const role of PLAN_ROLES) {
    const upper = role.toUpperCase();
    const ovRole = ov?.[role];
    const storeRole = store?.[role];
    const defRole = def[role];
    const runner = resolveStr(
      prov,
      `roles.${role}.runner`,
      overrideThenStore(
        rawScalar(ovRole?.runner),
        env[`AGENT_QUORUM_${upper}_RUNNER`],
        rawScalar(storeRole?.runner),
        rawScalar(defRole.runner),
      ),
    );
    if (!isRunner(runner)) {
      halt(
        `agent-quorum config: role '${role}' has invalid runner '${runner}' (expected codex, claude, or cursor)`,
      );
    }
    const model = resolveStr(
      prov,
      `roles.${role}.model`,
      overrideThenStore(
        rawScalar(ovRole?.model),
        env[`AGENT_QUORUM_${upper}_MODEL`],
        rawScalar(storeRole?.model),
        rawScalar(defRole.model),
      ),
    );
    const reasoning = resolveStr(
      prov,
      `roles.${role}.reasoning`,
      overrideThenStore(
        rawScalar(ovRole?.reasoning),
        env[`AGENT_QUORUM_${upper}_REASONING`],
        rawScalar(storeRole?.reasoning),
        rawScalar(defRole.reasoning),
      ),
    );
    matrix[role] = { runner, model, reasoning };
  }
  return matrix as RoleMatrix;
}

function resolveToolField(
  prov: Map<string, ConfigLayer>,
  role: Role,
  field: keyof OperatorRole,
  ov: DeepPartial<OperatorRoles> | undefined,
  store: DeepPartial<OperatorRoles> | undefined,
  def: OperatorRoles,
): string {
  const value = selectRaw(prov, `roles.${role}.${field}`, [
    ['override', rawToolField(ov?.[role]?.[field])],
    ['store', rawToolField(store?.[role]?.[field])],
    ['default', rawToolField(def[role][field])],
  ]);
  if (value === '') {
    halt(`agent-quorum config: role '${role}' ${field} is required and must be non-empty`);
  }
  return value;
}

function resolvePermissions(
  prov: Map<string, ConfigLayer>,
  ov: DeepPartial<OperatorRoles> | undefined,
  store: DeepPartial<OperatorRoles> | undefined,
  def: OperatorRoles,
): RolePermissions {
  const tools = (role: Role): RoleTools => ({
    tools: resolveToolField(prov, role, 'tools', ov, store, def),
    disallowedTools: resolveToolField(prov, role, 'disallowedTools', ov, store, def),
  });
  return {
    critic: tools('critic'),
    reviewer: tools('reviewer'),
    fixer: tools('fixer'),
    translator: tools('translator'),
    creator: {
      createTools: resolveToolField(prov, 'creator', 'createTools', ov, store, def),
      createDisallowedTools: resolveToolField(
        prov,
        'creator',
        'createDisallowedTools',
        ov,
        store,
        def,
      ),
      updateTools: resolveToolField(prov, 'creator', 'updateTools', ov, store, def),
      updateDisallowedTools: resolveToolField(
        prov,
        'creator',
        'updateDisallowedTools',
        ov,
        store,
        def,
      ),
    },
  };
}

function resolveStreamKnobs(
  prov: Map<string, ConfigLayer>,
  group: 'claude' | 'cursor',
  ov: DeepPartial<OperatorStreamKnobs> | undefined,
  store: DeepPartial<OperatorStreamKnobs> | undefined,
  env: NodeJS.ProcessEnv,
  def: OperatorStreamKnobs,
): ResolvedStreamKnobs {
  const upper = group.toUpperCase();
  const knob = (field: keyof OperatorStreamKnobs, envName: string, defValue: number): number =>
    resolveInt(
      prov,
      `knobs.${group}.${field}`,
      overrideThenStore(
        rawScalar(ov?.[field]),
        env[envName],
        rawScalar(store?.[field]),
        rawScalar(defValue),
      ),
      envName,
    );
  const byteTimeoutSeconds = knob(
    'stallTimeoutSeconds',
    `AGENT_QUORUM_${upper}_STALL_TIMEOUT_SECONDS`,
    def.stallTimeoutSeconds,
  );
  const pollSeconds = knob(
    'stallPollSeconds',
    `AGENT_QUORUM_${upper}_STALL_POLL_SECONDS`,
    def.stallPollSeconds,
  );
  const graceSeconds = knob(
    'stallInterruptGraceSeconds',
    `AGENT_QUORUM_${upper}_STALL_INTERRUPT_GRACE_SECONDS`,
    def.stallInterruptGraceSeconds,
  );
  const wallTimeoutSeconds = knob(
    'callTimeoutSeconds',
    `AGENT_QUORUM_${upper}_CALL_TIMEOUT_SECONDS`,
    def.callTimeoutSeconds,
  );
  const semanticTimeoutSeconds = knob(
    'semanticIdleTimeoutSeconds',
    `AGENT_QUORUM_${upper}_SEMANTIC_IDLE_TIMEOUT_SECONDS`,
    def.semanticIdleTimeoutSeconds,
  );
  return {
    byteTimeoutSeconds,
    pollSeconds,
    graceSeconds,
    wallTimeoutSeconds,
    semanticTimeoutSeconds,
  };
}

function resolvePassKnobs(
  prov: Map<string, ConfigLayer>,
  group: 'fixPass' | 'translatePass',
  envPrefix: string,
  ov: DeepPartial<OperatorPassKnobs> | undefined,
  store: DeepPartial<OperatorPassKnobs> | undefined,
  env: NodeJS.ProcessEnv,
  def: OperatorPassKnobs,
): OperatorPassKnobs {
  const knob = (field: keyof OperatorPassKnobs, envName: string, defValue: number): number =>
    resolveInt(
      prov,
      `knobs.${group}.${field}`,
      overrideThenStore(
        rawScalar(ov?.[field]),
        env[envName],
        rawScalar(store?.[field]),
        rawScalar(defValue),
      ),
      envName,
    );
  return {
    timeoutSeconds: knob('timeoutSeconds', `${envPrefix}_TIMEOUT_SECONDS`, def.timeoutSeconds),
    semanticIdleTimeoutSeconds: knob(
      'semanticIdleTimeoutSeconds',
      `${envPrefix}_SEMANTIC_IDLE_TIMEOUT_SECONDS`,
      def.semanticIdleTimeoutSeconds,
    ),
    retryCount: knob('retryCount', `${envPrefix}_RETRY_COUNT`, def.retryCount),
  };
}

function resolveSplitMode(raw: string): SplitMode {
  return raw === 'always' || raw === 'never' || raw === 'auto' ? raw : 'auto';
}

export function resolveConfig(input: ResolveConfigInput): ResolvedConfigResult {
  const env = input.env ?? process.env;
  const overrides = input.overrides ?? {};
  const cli = overrides.cli ?? {};
  const ov = overrides.config ?? {};
  const store = readConfigStore(input.home);
  const secrets = readSecretsStore(input.home);
  const def = DEFAULT_CONFIG;
  const prov = new Map<string, ConfigLayer>();

  const settings = resolveSettings(prov, cli, ov.settings, store.settings, env, def.settings);
  const matrix = resolveMatrix(prov, ov.roles, store.roles, env, def.roles);
  const permissions = resolvePermissions(prov, ov.roles, store.roles, def.roles);

  const knobs: ResolvedKnobs = {
    claude: resolveStreamKnobs(
      prov,
      'claude',
      ov.knobs?.claude,
      store.knobs?.claude,
      env,
      def.knobs.claude,
    ),
    cursor: resolveStreamKnobs(
      prov,
      'cursor',
      ov.knobs?.cursor,
      store.knobs?.cursor,
      env,
      def.knobs.cursor,
    ),
    fixPass: resolvePassKnobs(
      prov,
      'fixPass',
      'AGENT_QUORUM_FIX_PASS',
      ov.knobs?.fixPass,
      store.knobs?.fixPass,
      env,
      def.knobs.fixPass,
    ),
    translatePass: resolvePassKnobs(
      prov,
      'translatePass',
      'AGENT_QUORUM_TRANSLATE_PASS',
      ov.knobs?.translatePass,
      store.knobs?.translatePass,
      env,
      def.knobs.translatePass,
    ),
  };

  const split: OperatorSplit = {
    mode: resolveSplitMode(
      resolveStr(
        prov,
        'split.mode',
        overrideThenStore(
          rawScalar(ov.split?.mode),
          env.AGENT_QUORUM_SPLIT,
          rawScalar(store.split?.mode),
          rawScalar(def.split.mode),
        ),
      ),
    ),
    minPhases: resolveInt(
      prov,
      'split.minPhases',
      overrideThenStore(
        rawScalar(ov.split?.minPhases),
        env.AGENT_QUORUM_SPLIT_MIN_PHASES,
        rawScalar(store.split?.minPhases),
        rawScalar(def.split.minPhases),
      ),
      'AGENT_QUORUM_SPLIT_MIN_PHASES',
    ),
  };

  const retention: OperatorRetention = {
    keepCount: resolveInt(
      prov,
      'retention.keepCount',
      overrideThenStore(
        rawScalar(ov.retention?.keepCount),
        env.AGENT_QUORUM_RETAIN_COUNT,
        rawScalar(store.retention?.keepCount),
        rawScalar(def.retention.keepCount),
      ),
      'AGENT_QUORUM_RETAIN_COUNT',
    ),
    maxAgeDays: resolveInt(
      prov,
      'retention.maxAgeDays',
      overrideThenStore(
        rawScalar(ov.retention?.maxAgeDays),
        env.AGENT_QUORUM_RETAIN_DAYS,
        rawScalar(store.retention?.maxAgeDays),
        rawScalar(def.retention.maxAgeDays),
      ),
      'AGENT_QUORUM_RETAIN_DAYS',
    ),
  };

  const telegram = resolveTelegram(prov, ov, store, secrets, env, overrides.secrets, def);
  const providers = resolveProviders(prov, ov, store, env, def);

  const status: OperatorStatus = {
    maxPlanLines: resolveInt(
      prov,
      'status.maxPlanLines',
      overrideThenStore(
        rawScalar(ov.status?.maxPlanLines),
        env.AGENT_QUORUM_MAX_PLAN_LINES,
        rawScalar(store.status?.maxPlanLines),
        rawScalar(def.status.maxPlanLines),
      ),
      'AGENT_QUORUM_MAX_PLAN_LINES',
    ),
  };

  return {
    config: { settings, matrix, permissions, knobs, split, retention, telegram, providers, status },
    provenance: prov,
  };
}

export function resolveConfigForHome(home: string): ResolvedConfig {
  return resolveConfig({ home }).config;
}

function resolveTelegram(
  prov: Map<string, ConfigLayer>,
  ov: DeepPartial<OperatorConfig>,
  store: DeepPartial<OperatorConfig>,
  storeSecrets: Secrets,
  env: NodeJS.ProcessEnv,
  overrideSecrets: Secrets | undefined,
  def: OperatorConfig,
): ResolvedTelegram {
  const botToken = selectRaw(prov, 'telegram.botToken', [
    ['override', overrideSecrets?.telegramBotToken],
    ['env', env.AGENT_QUORUM_TELEGRAM_BOT_TOKEN],
    ['store', storeSecrets.telegramBotToken],
    ['default', ''],
  ]);
  const chatId = resolveStr(
    prov,
    'telegram.chatId',
    overrideThenStore(
      rawScalar(ov.telegram?.chatId),
      env.AGENT_QUORUM_TELEGRAM_CHAT_ID,
      rawScalar(store.telegram?.chatId),
      rawScalar(def.telegram.chatId),
    ),
  );
  const clarify = resolveStr(
    prov,
    'telegram.clarify',
    overrideThenStore(
      rawScalar(ov.telegram?.clarify),
      env.AGENT_QUORUM_CLARIFY,
      rawScalar(store.telegram?.clarify),
      rawScalar(def.telegram.clarify),
    ),
  );
  const clarifyDeadlineSeconds = resolveInt(
    prov,
    'telegram.clarifyDeadlineSeconds',
    overrideThenStore(
      rawScalar(ov.telegram?.clarifyDeadlineSeconds),
      env.AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS,
      rawScalar(store.telegram?.clarifyDeadlineSeconds),
      rawScalar(def.telegram.clarifyDeadlineSeconds),
    ),
    'AGENT_QUORUM_CLARIFY_DEADLINE_SECONDS',
  );
  const pollTimeoutSeconds = resolveInt(
    prov,
    'telegram.pollTimeoutSeconds',
    overrideThenStore(
      rawScalar(ov.telegram?.pollTimeoutSeconds),
      env.AGENT_QUORUM_TELEGRAM_POLL_TIMEOUT,
      rawScalar(store.telegram?.pollTimeoutSeconds),
      rawScalar(def.telegram.pollTimeoutSeconds),
    ),
    'AGENT_QUORUM_TELEGRAM_POLL_TIMEOUT',
  );
  const httpTimeoutSeconds = resolveInt(
    prov,
    'telegram.httpTimeoutSeconds',
    overrideThenStore(
      rawScalar(ov.telegram?.httpTimeoutSeconds),
      env.AGENT_QUORUM_TELEGRAM_HTTP_TIMEOUT,
      rawScalar(store.telegram?.httpTimeoutSeconds),
      rawScalar(def.telegram.httpTimeoutSeconds),
    ),
    'AGENT_QUORUM_TELEGRAM_HTTP_TIMEOUT',
  );
  const receiveFailureWindowSeconds = resolveInt(
    prov,
    'telegram.receiveFailureWindowSeconds',
    overrideThenStore(
      rawScalar(ov.telegram?.receiveFailureWindowSeconds),
      env.AGENT_QUORUM_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS,
      rawScalar(store.telegram?.receiveFailureWindowSeconds),
      rawScalar(def.telegram.receiveFailureWindowSeconds),
    ),
    'AGENT_QUORUM_TELEGRAM_RECEIVE_FAILURE_WINDOW_SECONDS',
  );
  const receiveBackoffSeconds = resolveInt(
    prov,
    'telegram.receiveBackoffSeconds',
    overrideThenStore(
      rawScalar(ov.telegram?.receiveBackoffSeconds),
      env.AGENT_QUORUM_TELEGRAM_RECEIVE_BACKOFF_SECONDS,
      rawScalar(store.telegram?.receiveBackoffSeconds),
      rawScalar(def.telegram.receiveBackoffSeconds),
    ),
    'AGENT_QUORUM_TELEGRAM_RECEIVE_BACKOFF_SECONDS',
  );
  // apiBase/stateDir are env-only rendezvous points, never persisted: env wins,
  // otherwise the built-in default.
  const apiBase = resolveStr(prov, 'telegram.apiBase', [
    ['env', env.AGENT_QUORUM_TELEGRAM_API_BASE],
    ['default', 'https://api.telegram.org'],
  ]);
  const stateDir = resolveStr(prov, 'telegram.stateDir', [
    ['env', env.AGENT_QUORUM_TELEGRAM_STATE_DIR],
    ['default', os.tmpdir()],
  ]);
  return {
    botToken,
    chatId,
    apiBase,
    stateDir,
    clarify,
    clarifyDeadlineSeconds,
    pollTimeoutSeconds,
    httpTimeoutSeconds,
    receiveFailureWindowSeconds,
    receiveBackoffSeconds,
  };
}

function resolveProviders(
  prov: Map<string, ConfigLayer>,
  ov: DeepPartial<OperatorConfig>,
  store: DeepPartial<OperatorConfig>,
  env: NodeJS.ProcessEnv,
  def: OperatorConfig,
): ResolvedProviders {
  const livenessHeartbeatSeconds = resolveInt(
    prov,
    'providers.livenessHeartbeatSeconds',
    overrideThenStore(
      rawScalar(ov.providers?.livenessHeartbeatSeconds),
      env.AGENT_QUORUM_LIVENESS_HEARTBEAT_SECONDS,
      rawScalar(store.providers?.livenessHeartbeatSeconds),
      rawScalar(def.providers.livenessHeartbeatSeconds),
    ),
    'AGENT_QUORUM_LIVENESS_HEARTBEAT_SECONDS',
  );
  const claudeThinkingEvery = resolveInt(
    prov,
    'providers.claudeThinkingEvery',
    overrideThenStore(
      rawScalar(ov.providers?.claudeThinkingEvery),
      env.AGENT_QUORUM_CLAUDE_THINKING_LOG_EVERY,
      rawScalar(store.providers?.claudeThinkingEvery),
      rawScalar(def.providers.claudeThinkingEvery),
    ),
    'AGENT_QUORUM_CLAUDE_THINKING_LOG_EVERY',
  );
  const cursorBin = resolveStr(
    prov,
    'providers.cursorBin',
    overrideThenStore(
      rawScalar(ov.providers?.cursorBin),
      env.AGENT_QUORUM_CURSOR_BIN,
      rawScalar(store.providers?.cursorBin),
      rawScalar(def.providers.cursorBin),
    ),
  );
  const providerDiagnostics = truthyFlag(
    selectRaw(
      prov,
      'providers.providerDiagnostics',
      overrideThenStore(
        rawScalar(ov.providers?.providerDiagnostics),
        env.AGENT_QUORUM_PROVIDER_DIAGNOSTICS,
        rawScalar(store.providers?.providerDiagnostics),
        rawScalar(def.providers.providerDiagnostics),
      ),
    ),
  );
  const claudePermissionMode = resolveStr(
    prov,
    'claudePermissionMode',
    overrideThenStore(
      rawScalar(ov.claudePermissionMode),
      env.CLAUDE_PERMISSION_MODE,
      rawScalar(store.claudePermissionMode),
      rawScalar(def.claudePermissionMode),
    ),
  );
  return {
    livenessHeartbeatSeconds,
    claudeThinkingEvery,
    cursorBin,
    providerDiagnostics,
    claudePermissionMode,
  };
}
