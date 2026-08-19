import path from 'node:path';
import {
  resolveConfig,
  type ResolvedConfig,
  type ResolvedTelegram,
  type RoleMatrix,
  type RolePermissions,
  type RunSettings,
} from '../../src/core/config.js';
import { qualityMatrix } from '../../src/core/quality.js';
import { DEFAULT_SPLIT_MIN_PHASES } from '../../src/stages/plan/plan-package.js';
import type { SplitMode } from '../../src/core/split-policy.js';
import { skillPaths, type RunContext } from '../../src/core/run-context.js';
import { DISABLED_STREAM_KNOBS } from '../../src/providers/registry.js';
import type { StreamKnobs } from '../../src/providers/watchdog.js';
import type { Scratch } from '../../src/runtime/scratch.js';
import { REPO_ROOT } from './harness.js';
import { createConvergenceState } from '../../src/core/convergence.js';
import type { SystemContext } from '../../src/core/system-context.js';

export const BASE_STREAM_KNOBS: StreamKnobs = {
  stallStatus: 124,
  pollSeconds: 1,
  graceSeconds: 1,
  byteTimeoutSeconds: 0,
  semanticTimeoutSeconds: 0,
  wallTimeoutSeconds: 0,
};

export function fixturePermissions(): RolePermissions {
  const disallowed = 'Write,Edit,NotebookEdit,Bash,Agent,Task,ToolSearch,AskUserQuestion';
  return {
    creator: {
      createTools: 'Read,Grep,Glob',
      createDisallowedTools: 'Write,Edit,NotebookEdit,Agent,Task,ToolSearch,AskUserQuestion',
      updateTools: 'Read',
      updateDisallowedTools: disallowed,
    },
    critic: { tools: 'Read,Grep,Glob', disallowedTools: disallowed },
    fixer: { tools: 'Read,Grep,Glob', disallowedTools: disallowed },
    reviewer: { tools: 'Read,Grep,Glob', disallowedTools: disallowed },
    translator: { tools: 'Read,Grep,Glob', disallowedTools: disallowed },
    judge: { tools: 'Read,Grep,Glob', disallowedTools: disallowed },
  };
}

export function fixtureMatrix(): RoleMatrix {
  return {
    creator: { runner: 'claude', model: 'claude-opus-4-8', reasoning: 'xhigh' },
    critic: { runner: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' },
    fixer: { runner: 'claude', model: 'claude-opus-4-8', reasoning: 'xhigh' },
    reviewer: { runner: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' },
    translator: { runner: 'claude', model: 'claude-sonnet-4-6', reasoning: 'high' },
    judge: { runner: 'claude', model: 'claude-opus-4-8', reasoning: 'xhigh' },
  };
}

export interface TestContextOptions {
  quality?: 'quick' | 'balanced' | 'thorough';
  maxIters?: number;
  diffThreshold?: number;
  projectRoot?: string;
  fixPass?: 0 | 1;
  translatePass?: 0 | 1;
  locale?: string;
  matrix?: RoleMatrix;
  mode?: 'plan' | 'prompt';
  splitMode?: SplitMode;
  splitMinPhases?: number;
  maxPlanLines?: number;
  sourceDigest?: string;
  telegram?: Partial<ResolvedTelegram>;
  claudePermissionMode?: string;
}

export function makeTestRunContext(
  tmp: string,
  work: string,
  scratch: Scratch,
  options: TestContextOptions = {},
): RunContext {
  const quality = options.quality ?? 'quick';
  const settings: RunSettings = {
    maxIters: options.maxIters ?? 1,
    quality,
    fixPass: options.fixPass ?? 0,
    translatePass: options.translatePass ?? 0,
    locale: options.locale ?? 'en',
    diffThreshold: options.diffThreshold ?? 5,
    retryCount: 0,
    retryDelaySeconds: 0,
  };
  const matrix = options.matrix ?? fixtureMatrix();
  const permissions = fixturePermissions();
  const base = resolveConfig({ overrides: {}, env: {}, home: tmp }).config;
  const config: ResolvedConfig = {
    ...base,
    settings,
    matrix,
    permissions,
    telegram: { ...base.telegram, ...options.telegram },
  };
  const systemContext: SystemContext = {
    schemaVersion: 1,
    scopeSource: options.mode === 'prompt' ? 'prompt' : 'direct-plan',
    originalRequestAvailable: options.mode === 'prompt',
    declaredScope: [],
    sources: [],
    digest: 'test-system-digest',
    crossRepository: false,
    relationships: [],
    limitations: [],
    facts: {
      repositories: [],
      packages: [],
      packageExports: [],
      packageScripts: [],
      images: [],
      workflows: [],
      ciTriggers: [],
      regions: [],
      migrationCommands: [],
      deliveryStages: [],
      authorizationBoundaries: [],
      gates: [],
    },
  };
  const convergence = createConvergenceState({
    quality,
    matrix: qualityMatrix(quality),
    mode: options.mode ?? 'plan',
    sourceDigest: options.sourceDigest ?? 'test-source-digest',
    authoritativeDigest: systemContext.digest,
    relationshipIds: [],
    maxIters: settings.maxIters,
  });
  return {
    work,
    mode: options.mode ?? 'plan',
    inputPath: path.join(tmp, 'input.md'),
    plansDir: path.join(tmp, 'plans'),
    config,
    settings,
    quality: qualityMatrix(quality),
    permissions,
    skills: skillPaths(REPO_ROOT),
    provider: {
      scratch,
      projectRoot: options.projectRoot ?? tmp,
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      streamKnobs: {
        codex: DISABLED_STREAM_KNOBS,
        claude: BASE_STREAM_KNOBS,
        cursor: BASE_STREAM_KNOBS,
      },
      matrix,
      sessionMode: qualityMatrix(quality).sessionMode,
      creatorSessionFile: path.join(work, 'creator.session-id'),
      markdownSchemaPath: path.join(REPO_ROOT, 'skills', '_shared', 'markdown.schema.json'),
      binaries: { codex: 'codex', claude: 'claude', cursor: 'cursor-agent' },
      livenessHeartbeatSeconds: 0,
      claudeThinkingEvery: 3,
      ...(options.claudePermissionMode !== undefined
        ? { claudePermissionMode: options.claudePermissionMode }
        : {}),
    },
    passes: {
      fixPass: { timeoutSeconds: 0, semanticIdleTimeoutSeconds: 0, retryCount: 0 },
      translatePass: { timeoutSeconds: 0, semanticIdleTimeoutSeconds: 0, retryCount: 0 },
    },
    maxPlanLines: options.maxPlanLines ?? 900,
    split: {
      mode: options.splitMode ?? 'auto',
      minPhases: options.splitMinPhases ?? DEFAULT_SPLIT_MIN_PHASES,
    },
    lastCritiqueIter: -1,
    resume: { startIter: 0, archivedCount: 0, archiveDir: '' },
    convergence,
    systemContext,
  };
}
