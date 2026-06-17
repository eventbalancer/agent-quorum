import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { err, log } from '../runtime/log.js';
import { cursorSessionArgs } from './session.js';
import { CursorStreamLogFilter } from './stream-log.js';
import {
  extractJsonPayload,
  extractResultField,
  runStreamingCli,
  defaultJsonExtractionContext,
} from './stream-runner.js';
import type { DiagnosticSink, TraceContext } from './trace.js';
import { cursorProgressEvent } from './watchdog.js';
import { stripTrailingNewlines, type ProviderRuntime } from './runtime.js';

const CURSOR_STALL_RESUME_PROMPT =
  'The previous Cursor Agent turn in this same session was interrupted by the agent-quorum watchdog because it stopped making progress within the configured limit.\n' +
  '\n' +
  'Continue the original task using the context already gathered in this session. Return the exact output requested by the original prompt and current output mode. Do not ask user questions. If enough evidence is already gathered, produce the final output now.\n';

export function cursorCliSupportsFlag(cursorBin: string, flag: string): boolean {
  const result = spawnSync(cursorBin, ['--help'], { encoding: 'utf8' });
  const combined = `${result.stdout || ''}${result.stderr || ''}`;
  return combined.includes(` ${flag}`);
}

interface CursorStreamOutcome {
  readonly status: number;
  readonly output: string;
}

async function cursorStream(
  providerRuntime: ProviderRuntime,
  promptText: string,
  args: readonly string[],
  captureFile: string,
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<CursorStreamOutcome> {
  const filter = new CursorStreamLogFilter();
  const result = await runStreamingCli({
    command: providerRuntime.binaries.cursor,
    args: ['-p', '--output-format', 'stream-json', ...args],
    promptText,
    cwd: providerRuntime.projectRoot,
    knobs: providerRuntime.streamKnobs.cursor,
    renderLine: (line) => filter.line(line),
    progressEvent: cursorProgressEvent,
    traceContext,
    liveness: true,
    ...(diagnosticSink !== undefined ? { diagnosticSink } : {}),
  });
  const output = extractResultField(result.streamLines, 'result');
  if (captureFile !== '') {
    const sessionRendering = extractResultField(result.streamLines, 'session_id');
    const sessionId = sessionRendering.split('\n')[0] ?? '';
    if (sessionId !== '') {
      writeFileSync(captureFile, sessionId);
    }
  }
  let status = result.status;
  if (result.stallReason !== undefined) {
    err(`cursor stream stalled: ${result.stallReason}`);
    status = providerRuntime.streamKnobs.cursor.stallStatus;
  }
  return { status, output };
}

type CursorMode = 'json' | 'markdown';

async function cursorStreamToFile(
  providerRuntime: ProviderRuntime,
  mode: CursorMode,
  promptText: string,
  outFile: string,
  args: readonly string[],
  captureFile: string,
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<number> {
  const { status, output } = await cursorStream(
    providerRuntime,
    promptText,
    args,
    captureFile,
    traceContext,
    diagnosticSink,
  );
  if (mode === 'markdown') {
    writeFileSync(outFile, output);
    if (status !== 0) {
      return status;
    }
    if (output.length === 0) {
      err('cursor produced no final result');
      return 4;
    }
    return 0;
  }

  if (status !== 0) {
    return status;
  }
  if (output.length === 0) {
    err('cursor produced no final result');
    return 4;
  }
  const extracted = extractJsonPayload(output, defaultJsonExtractionContext);
  writeFileSync(outFile, extracted.content);
  return 0;
}

async function cursorRunOnce(
  providerRuntime: ProviderRuntime,
  mode: CursorMode,
  promptText: string,
  outFile: string,
  sessionFile: string,
  invokeArgs: readonly string[],
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<number> {
  const session = cursorSessionArgs(sessionFile);
  const wasResume = session.wasResume;
  let attemptedStallResume = false;
  const captureFile = sessionFile;

  rmSync(outFile, { force: true });
  let status = await cursorStreamToFile(
    providerRuntime,
    mode,
    promptText,
    outFile,
    [...session.args, ...invokeArgs],
    captureFile,
    traceContext,
    diagnosticSink,
  );
  if (status === 0) {
    return 0;
  }

  const isStallWithLiveSession =
    status === providerRuntime.streamKnobs.cursor.stallStatus &&
    sessionFile !== '' &&
    nonEmptyFile(sessionFile);
  if (isStallWithLiveSession) {
    log('WARNING: creator stream stalled; resuming the same cursor session once');
    const resumeArgs = ['--resume', readFileSync(sessionFile, 'utf8').trim()];
    attemptedStallResume = true;
    rmSync(outFile, { force: true });
    status = await cursorStreamToFile(
      providerRuntime,
      mode,
      CURSOR_STALL_RESUME_PROMPT,
      outFile,
      [...resumeArgs, ...invokeArgs],
      captureFile,
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
      log('WARNING: creator cursor session resume failed; re-establishing session');
      const freshSession = cursorSessionArgs(sessionFile);
      rmSync(outFile, { force: true });
      return cursorStreamToFile(
        providerRuntime,
        mode,
        promptText,
        outFile,
        [...freshSession.args, ...invokeArgs],
        captureFile,
        traceContext,
        diagnosticSink,
      );
    }
  }

  return status;
}

export interface CursorInvokeInput {
  readonly skillFile: string;
  readonly tools: string;
  readonly disallowedTools: string;
  readonly model: string;
  readonly sessionFile: string;
  readonly schemaFile: string;
  readonly promptBody: string;
}

interface CursorPromptAndArgs {
  readonly args: string[];
  readonly fullPrompt: string;
}

function cursorPromptAndArgs(
  providerRuntime: ProviderRuntime,
  input: CursorInvokeInput,
): CursorPromptAndArgs {
  const args = ['--workspace', providerRuntime.projectRoot, '--model', input.model];
  if (cursorCliSupportsFlag(providerRuntime.binaries.cursor, '--trust')) {
    args.push('--trust');
  }
  if (cursorCliSupportsFlag(providerRuntime.binaries.cursor, '--approve-mcps')) {
    args.push('--approve-mcps');
  }

  let schemaHint = '';
  if (input.schemaFile !== '') {
    const schemaContent = stripTrailingNewlines(readFileSync(input.schemaFile, 'utf8'));
    schemaHint = `\n## JSON schema\nReturn ONLY JSON conforming to this schema. No prose, no markdown fences.\n\n${schemaContent}`;
  }
  let toolsHint = '';
  if (input.tools !== '' || input.disallowedTools !== '') {
    const tools = input.tools === '' ? 'none' : input.tools;
    const disallowed = input.disallowedTools === '' ? 'none' : input.disallowedTools;
    toolsHint =
      '\n## Tool constraints\n' +
      'Read-only mode: inspect the repo if needed, but do not write, edit, or delete files and do not run shell commands that modify state.\n' +
      `Use only these tools when inspecting the codebase: ${tools}.\n` +
      `Do not use: ${disallowed}.`;
  }
  const skill = stripTrailingNewlines(readFileSync(input.skillFile, 'utf8'));
  const body = stripTrailingNewlines(input.promptBody);
  const fullPrompt = `${skill}${toolsHint}${schemaHint}\n\n${body}\n`;
  return { args, fullPrompt };
}

export async function cursorInvoke(
  providerRuntime: ProviderRuntime,
  mode: CursorMode,
  outFile: string,
  input: CursorInvokeInput,
  traceContext: TraceContext,
  diagnosticSink: DiagnosticSink | undefined,
): Promise<number> {
  const { args, fullPrompt } = cursorPromptAndArgs(providerRuntime, input);
  return cursorRunOnce(
    providerRuntime,
    mode,
    fullPrompt,
    outFile,
    input.sessionFile,
    args,
    traceContext,
    diagnosticSink,
  );
}
