import path from 'node:path';
import type { RoleMatrix, RolePermissions } from '../../src/core/config.js';
import { effortMatrix } from '../../src/core/effort.js';
import { skillPaths, type RunContext } from '../../src/core/run-context.js';
import type { Scratch } from '../../src/runtime/scratch.js';
import { REPO_ROOT } from './harness.js';

export function fixturePermissions(): RolePermissions {
  const disallowed = 'Write,Edit,NotebookEdit,Bash,Agent,Task,ToolSearch,AskUserQuestion';
  return {
    critic: { tools: 'Read,Grep,Glob', disallowedTools: disallowed },
    reviewer: { tools: 'Read,Grep,Glob', disallowedTools: disallowed },
    fixer: { tools: 'Read,Grep,Glob', disallowedTools: disallowed },
    creator: {
      createTools: 'Read,Grep,Glob',
      createDisallowedTools: 'Write,Edit,NotebookEdit,Agent,Task,ToolSearch,AskUserQuestion',
      updateTools: 'Read',
      updateDisallowedTools: disallowed,
    },
    translator: { tools: 'Read,Grep,Glob', disallowedTools: disallowed },
  };
}

export function fixtureMatrix(): RoleMatrix {
  return {
    critic: { runner: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' },
    creator: { runner: 'claude', model: 'claude-opus-4-8', reasoning: 'xhigh' },
    fixer: { runner: 'claude', model: 'claude-opus-4-8', reasoning: 'xhigh' },
    reviewer: { runner: 'codex', model: 'gpt-5.5', reasoning: 'xhigh' },
    translator: { runner: 'claude', model: 'claude-sonnet-4-6', reasoning: 'high' },
  };
}

export interface TestContextOptions {
  effort?: 'low' | 'high' | 'max';
  maxIters?: number;
  diffThreshold?: number;
  projectRoot?: string;
  fixPass?: 0 | 1;
  translatePass?: 0 | 1;
  matrix?: RoleMatrix;
  mode?: 'plan' | 'prompt';
}

export function makeTestRunContext(
  tmp: string,
  work: string,
  scratch: Scratch,
  options: TestContextOptions = {},
): RunContext {
  const effort = options.effort ?? 'low';
  return {
    work,
    mode: options.mode ?? 'plan',
    inputPath: path.join(tmp, 'input.md'),
    plansDir: path.join(tmp, 'plans'),
    settings: {
      maxIters: options.maxIters ?? 1,
      effort,
      fixPass: options.fixPass ?? 0,
      translatePass: options.translatePass ?? 0,
      diffThreshold: options.diffThreshold ?? 5,
      retryCount: 0,
      retryDelaySeconds: 0,
    },
    effort: effortMatrix(effort),
    permissions: fixturePermissions(),
    skills: skillPaths(REPO_ROOT),
    provider: {
      scratch,
      projectRoot: options.projectRoot ?? tmp,
      retry: { retryCount: 0, retryDelaySeconds: 0 },
      claudeKnobs: {
        stallStatus: 124,
        pollSeconds: 1,
        graceSeconds: 1,
        byteTimeoutSeconds: 0,
        semanticTimeoutSeconds: 0,
        wallTimeoutSeconds: 0,
      },
      cursorKnobs: {
        stallStatus: 124,
        pollSeconds: 1,
        graceSeconds: 1,
        byteTimeoutSeconds: 0,
        semanticTimeoutSeconds: 0,
        wallTimeoutSeconds: 0,
      },
      matrix: options.matrix ?? fixtureMatrix(),
      sessionMode: effortMatrix(effort).sessionMode,
      creatorSessionFile: path.join(work, 'creator.session-id'),
      markdownSchemaPath: path.join(REPO_ROOT, 'skills', '_shared', 'markdown.schema.json'),
      cursorBin: 'cursor-agent',
    },
    passes: {
      fixPass: { timeoutSeconds: 0, semanticIdleTimeoutSeconds: 0, retryCount: 0 },
      translatePass: { timeoutSeconds: 0, semanticIdleTimeoutSeconds: 0, retryCount: 0 },
    },
    maxPlanLines: 900,
    lastCritiqueIter: -1,
    resume: { startIter: 0, archivedCount: 0, archiveDir: '' },
  };
}
