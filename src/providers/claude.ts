import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { err, log } from '../runtime/log.js';
import { claudeSessionArgs } from './session.js';
import { StreamLogFilter } from './stream-log.js';
import {
  extractJsonPayload,
  extractResultField,
  runStreamingCli,
  defaultJsonExtractionContext,
} from './stream-runner.js';
import type { DiagnosticSink, TraceContext } from './trace.js';
import { claudeProgressEvent } from './watchdog.js';
import {
  resolveClaudePermissionMode,
  stripTrailingNewlines,
  type ProviderRuntime,
} from './runtime.js';

const CLAUDE_STALL_RESUME_PROMPT =
  'The previous Claude Code CLI turn in this same session was interrupted by the agent-quorum watchdog because it stopped making progress within the configured limit.\n' +
  '\n' +
  'Continue the original task using the context already gathered in this session. Return the exact output requested by the original prompt and current output mode. Do not ask user questions. If enough evidence is already gathered, produce the final output now.\n';

interface ClaudeStreamOutcome {
  readonly status: number;
  readonly output: string;
}

async function claudeStream(
  providerRuntime: ProviderRuntime,
  promptText: string,
  args: readonly string[],
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<ClaudeStreamOutcome> {
  const filter = new StreamLogFilter();
  const result = await runStreamingCli({
    command: providerRuntime.binaries.claude,
    args: ['-p', '--verbose', '--output-format', 'stream-json', ...args],
    promptText,
    cwd: providerRuntime.projectRoot,
    knobs: providerRuntime.streamKnobs.claude,
    renderLine: (line) => filter.line(line),
    progressEvent: claudeProgressEvent,
    traceContext,
    ...(diagnosticSink !== undefined ? { diagnosticSink } : {}),
  });
  const output = extractResultField(result.streamLines, 'result');
  let status = result.status;
  if (result.stallReason !== undefined) {
    err(`claude stream stalled: ${result.stallReason}`);
    status = providerRuntime.streamKnobs.claude.stallStatus;
  }
  return { status, output };
}

type ClaudeMode = 'json' | 'markdown';

async function claudeStreamToFile(
  providerRuntime: ProviderRuntime,
  mode: ClaudeMode,
  promptText: string,
  outFile: string,
  args: readonly string[],
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<number> {
  const { status, output } = await claudeStream(
    providerRuntime,
    promptText,
    args,
    traceContext,
    diagnosticSink,
  );
  if (mode === 'markdown') {
    writeFileSync(outFile, output);
    if (status !== 0) {
      return status;
    }
    if (output.length === 0) {
      err('claude produced no final result');
      return 4;
    }
    return 0;
  }

  if (status !== 0) {
    return status;
  }
  if (output.length === 0) {
    err('claude produced no final result');
    return 4;
  }
  const extracted = extractJsonPayload(output, defaultJsonExtractionContext);
  writeFileSync(outFile, extracted.content);
  return 0;
}

// Session self-heal only; transient-failure retries are owned by providerRun.
async function claudeRunOnce(
  providerRuntime: ProviderRuntime,
  mode: ClaudeMode,
  promptText: string,
  outFile: string,
  sessionFile: string,
  invokeArgs: readonly string[],
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<number> {
  const session = claudeSessionArgs(sessionFile);
  const wasResume = session.wasResume;
  let attemptedStallResume = false;

  rmSync(outFile, { force: true });
  let status = await claudeStreamToFile(
    providerRuntime,
    mode,
    promptText,
    outFile,
    [...session.args, ...invokeArgs],
    traceContext,
    diagnosticSink,
  );
  if (status === 0) {
    return 0;
  }

  const isStallWithLiveSession =
    status === providerRuntime.streamKnobs.claude.stallStatus &&
    sessionFile !== '' &&
    nonEmptyFile(sessionFile);
  if (isStallWithLiveSession) {
    log('WARNING: creator stream stalled; resuming the same session once');
    const resumeArgs = ['--resume', readFileSync(sessionFile, 'utf8').trim()];
    attemptedStallResume = true;
    rmSync(outFile, { force: true });
    status = await claudeStreamToFile(
      providerRuntime,
      mode,
      CLAUDE_STALL_RESUME_PROMPT,
      outFile,
      [...resumeArgs, ...invokeArgs],
      traceContext,
      diagnosticSink,
    );
    if (status === 0) {
      return 0;
    }
  }

  if (sessionFile !== '') {
    rmSync(sessionFile, { force: true });
    if (wasResume || attemptedStallResume) {
      log('WARNING: creator session resume failed; re-establishing session');
      const freshSession = claudeSessionArgs(sessionFile);
      rmSync(outFile, { force: true });
      return claudeStreamToFile(
        providerRuntime,
        mode,
        promptText,
        outFile,
        [...freshSession.args, ...invokeArgs],
        traceContext,
        diagnosticSink,
      );
    }
  }

  return status;
}

function claudeInvokeArgs(
  providerRuntime: ProviderRuntime,
  skillFile: string,
  tools: string,
  disallowedTools: string,
  model: string,
  effort: string,
  schemaFile?: string,
): string[] {
  const permissionMode = resolveClaudePermissionMode(providerRuntime);
  const args = [
    '--append-system-prompt',
    stripTrailingNewlines(readFileSync(skillFile, 'utf8')),
    '--permission-mode',
    permissionMode,
    '--model',
    model,
  ];
  if (schemaFile !== undefined && schemaFile !== '') {
    args.push('--json-schema', stripTrailingNewlines(readFileSync(schemaFile, 'utf8')));
  }
  args.push(
    '--effort',
    effort,
    '--tools',
    tools,
    '--allowed-tools',
    tools,
    '--disallowed-tools',
    disallowedTools,
  );
  return args;
}

export async function claudeInvoke(
  providerRuntime: ProviderRuntime,
  mode: ClaudeMode,
  outFile: string,
  skillFile: string,
  tools: string,
  disallowedTools: string,
  model: string,
  effort: string,
  sessionFile: string,
  schemaFile: string | undefined,
  promptText: string,
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<number> {
  const args = claudeInvokeArgs(
    providerRuntime,
    skillFile,
    tools,
    disallowedTools,
    model,
    effort,
    schemaFile,
  );
  return claudeRunOnce(
    providerRuntime,
    mode,
    promptText,
    outFile,
    sessionFile,
    args,
    traceContext,
    diagnosticSink,
  );
}
