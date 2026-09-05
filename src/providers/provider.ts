import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { err, log } from '../runtime/log.js';
import { runWithRetries } from '../runtime/retry.js';
import type { ExecutionControl } from '../runtime/execution-control.js';
import { isJsonObject, type JsonValue } from '../core/json.js';
import type { Role } from '../types.js';
import type { Runner } from './registry.js';
import { codexRun } from './codex.js';
import { claudeInvoke } from './claude.js';
import { cursorInvoke } from './cursor.js';
import {
  createDiagnosticSink,
  type DiagnosticSink,
  type ProviderFailureReason,
  type TraceContext,
} from './trace.js';
import { roleSessionFile, stripTrailingNewlines, type ProviderRuntime } from './runtime.js';

export type ProviderMode = 'json' | 'markdown';

async function providerRunCodex(
  providerRuntime: ProviderRuntime,
  mode: ProviderMode,
  outFile: string,
  skillFile: string,
  schemaFile: string,
  model: string,
  reasoning: string,
  promptText: string,
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<number> {
  const skill = stripTrailingNewlines(readFileSync(skillFile, 'utf8'));
  const fullPrompt = `${skill}\n\n${stripTrailingNewlines(promptText)}`;
  if (mode === 'json') {
    return codexRun(
      providerRuntime,
      model,
      reasoning,
      schemaFile,
      outFile,
      fullPrompt,
      traceContext,
      diagnosticSink,
    );
  }

  const wrap = providerRuntime.scratch.file();
  const status = await codexRun(
    providerRuntime,
    model,
    reasoning,
    providerRuntime.markdownSchemaPath,
    wrap,
    fullPrompt,
    traceContext,
    diagnosticSink,
  );
  if (status !== 0) {
    rmSync(wrap, { force: true });
    return status;
  }
  let rendered: string;
  try {
    const parsed = JSON.parse(readFileSync(wrap, 'utf8')) as JsonValue;
    const value = isJsonObject(parsed) ? (parsed.plan_markdown ?? null) : null;
    rendered = typeof value === 'string' ? `${value}\n` : `${JSON.stringify(value, null, 2)}\n`;
  } catch {
    rendered = '';
  }
  writeFileSync(outFile, rendered);
  rmSync(wrap, { force: true });
  if (!nonEmptyFile(outFile)) {
    err('codex markdown extraction produced empty output');
    return 4;
  }
  return 0;
}

export interface ProviderCallInput {
  readonly providerRuntime: ProviderRuntime;
  readonly mode: ProviderMode;
  readonly outFile: string;
  readonly skillFile: string;
  readonly schemaFile: string;
  readonly tools: string;
  readonly disallowedTools: string;
  readonly model: string;
  readonly reasoning: string;
  readonly sessionFile: string;
  readonly promptText: string;
  readonly traceContext: TraceContext;
  readonly diagnosticSink: DiagnosticSink | undefined;
}

export interface ProviderAttemptOutcome {
  readonly status: number;
  readonly failureReason: ProviderFailureReason | undefined;
}

export interface ProviderOutputValidation {
  readonly valid: boolean;
  readonly retryPrompt?: string;
}

export type ProviderOutputValidationResult = boolean | ProviderOutputValidation;

export interface ProviderRunOptions {
  readonly validateOutput?: (outFile: string) => ProviderOutputValidationResult;
}

export interface ProviderTaskRequest extends ProviderRunOptions {
  readonly task: string;
  readonly runner: Runner;
  readonly model: string;
  readonly reasoning: string;
  readonly mode: ProviderMode;
  readonly outFile: string;
  readonly skillFile: string;
  readonly schemaFile: string;
  readonly promptText: string;
  readonly cwd?: string;
  readonly tools?: string;
  readonly disallowedTools?: string;
  readonly execution?: ExecutionControl;
  readonly codexConfig?: readonly string[];
  readonly isolatedUserConfig?: boolean;
  readonly codexPermissionProfile?: string;
}

export type ProviderInvoke = (input: ProviderCallInput) => Promise<ProviderAttemptOutcome>;

// Keyed by Runner via `satisfies`, so an omitted adapter is a compile error
// naming the missing runner. Exported for the registry guard test but
// deliberately not re-exported from src/index.ts (internal, not public surface).
export const PROVIDER_DISPATCH = {
  codex: async (input) => {
    const status = await providerRunCodex(
      input.providerRuntime,
      input.mode,
      input.outFile,
      input.skillFile,
      input.schemaFile,
      input.model,
      input.reasoning,
      input.promptText,
      input.traceContext,
      input.diagnosticSink,
    );
    return { status, failureReason: undefined };
  },
  claude: (input) =>
    claudeInvoke(
      input.providerRuntime,
      input.mode,
      input.outFile,
      input.skillFile,
      input.tools,
      input.disallowedTools,
      input.model,
      input.reasoning,
      input.sessionFile,
      input.mode === 'json' ? input.schemaFile : undefined,
      input.promptText,
      input.traceContext,
      input.diagnosticSink,
    ),
  cursor: async (input) => {
    if (input.reasoning !== '') {
      log(`WARNING: cursor runner ignores reasoning/effort field (reasoning=${input.reasoning})`);
    }
    const status = await cursorInvoke(
      input.providerRuntime,
      input.mode,
      input.outFile,
      {
        skillFile: input.skillFile,
        tools: input.tools,
        disallowedTools: input.disallowedTools,
        model: input.model,
        sessionFile: input.sessionFile,
        schemaFile: input.mode === 'json' ? input.schemaFile : '',
        promptBody: input.promptText,
      },
      input.traceContext,
      input.diagnosticSink,
    );
    return { status, failureReason: undefined };
  },
} satisfies Record<Runner, ProviderInvoke>;

async function providerRunOnce(
  providerRuntime: ProviderRuntime,
  role: Role,
  mode: ProviderMode,
  outFile: string,
  skillFile: string,
  schemaFile: string,
  tools: string,
  disallowedTools: string,
  promptText: string,
  task?: ProviderTaskRequest,
): Promise<ProviderAttemptOutcome> {
  const entry = task ?? providerRuntime.matrix[role];
  const sessionFile = task === undefined ? roleSessionFile(providerRuntime, role) : '';
  const traceContext: TraceContext = {
    role: task?.task ?? role,
    provider: entry.runner,
    model: entry.model,
  };
  const diagnosticSink =
    providerRuntime.diagnosticsDir !== undefined
      ? createDiagnosticSink(providerRuntime.diagnosticsDir, traceContext)
      : undefined;
  try {
    return await PROVIDER_DISPATCH[entry.runner]({
      providerRuntime,
      mode,
      outFile,
      skillFile,
      schemaFile,
      tools,
      disallowedTools,
      model: entry.model,
      reasoning: entry.reasoning,
      sessionFile,
      promptText,
      traceContext,
      diagnosticSink,
    });
  } finally {
    diagnosticSink?.close();
  }
}

export function providerRun(
  providerRuntime: ProviderRuntime,
  request: ProviderTaskRequest,
): Promise<number>;
export function providerRun(
  providerRuntime: ProviderRuntime,
  role: Role,
  mode: ProviderMode,
  outFile: string,
  skillFile: string,
  schemaFile: string,
  tools: string,
  disallowedTools: string,
  promptText: string,
  options?: ProviderRunOptions,
): Promise<number>;
export async function providerRun(
  initialRuntime: ProviderRuntime,
  roleOrTask: Role | ProviderTaskRequest,
  initialMode?: ProviderMode,
  initialOutFile?: string,
  initialSkillFile?: string,
  initialSchemaFile?: string,
  initialTools?: string,
  initialDisallowedTools?: string,
  initialPromptText?: string,
  initialOptions: ProviderRunOptions = {},
): Promise<number> {
  const task = typeof roleOrTask === 'string' ? undefined : roleOrTask;
  const role = typeof roleOrTask === 'string' ? roleOrTask : 'creator';
  const providerRuntime: ProviderRuntime =
    task === undefined
      ? initialRuntime
      : {
          ...initialRuntime,
          projectRoot: task.cwd ?? initialRuntime.projectRoot,
          ...(task.execution === undefined ? {} : { execution: task.execution }),
          ...(task.codexConfig === undefined ? {} : { codexConfig: task.codexConfig }),
          ...(task.isolatedUserConfig === undefined
            ? {}
            : { isolatedUserConfig: task.isolatedUserConfig }),
          ...(task.codexPermissionProfile === undefined
            ? {}
            : { codexPermissionProfile: task.codexPermissionProfile }),
        };
  const mode = task?.mode ?? initialMode;
  const outFile = task?.outFile ?? initialOutFile;
  const skillFile = task?.skillFile ?? initialSkillFile;
  const schemaFile = task?.schemaFile ?? initialSchemaFile;
  const tools = task?.tools ?? initialTools ?? '';
  const disallowedTools = task?.disallowedTools ?? initialDisallowedTools ?? '';
  const promptText = task?.promptText ?? initialPromptText;
  const options = task ?? initialOptions;
  if (
    mode === undefined ||
    outFile === undefined ||
    skillFile === undefined ||
    schemaFile === undefined ||
    promptText === undefined
  ) {
    throw new TypeError('provider request is incomplete');
  }
  if (task !== undefined && !/^[a-z][a-z0-9-]*$/.test(task.task)) {
    throw new TypeError('provider task must be a lowercase task identifier');
  }
  const runner = task?.runner ?? providerRuntime.matrix[role].runner;
  let retryPrompt = '';
  return runWithRetries(
    `${runner} call`,
    providerRuntime.retry,
    async () => {
      const outcome = await providerRunOnce(
        providerRuntime,
        role,
        mode,
        outFile,
        skillFile,
        schemaFile,
        tools,
        disallowedTools,
        retryPrompt === '' ? promptText : `${promptText}\n\n${retryPrompt}`,
        task,
      );
      const isClaudeSchemaRejection =
        runner === 'claude' && mode === 'json' && outcome.failureReason === 'schema-incompatible';
      if (outcome.status === 0 && options.validateOutput !== undefined) {
        const validation = options.validateOutput(outFile);
        const valid = typeof validation === 'boolean' ? validation : validation.valid;
        if (!valid && typeof validation !== 'boolean' && validation.retryPrompt !== undefined) {
          retryPrompt = validation.retryPrompt;
        }
        return { status: valid ? 0 : 1, retryable: true };
      }
      return { status: outcome.status, retryable: !isClaudeSchemaRejection };
    },
    providerRuntime.execution,
  );
}
