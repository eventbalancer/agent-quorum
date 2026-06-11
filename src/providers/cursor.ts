import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { err, log } from '../runtime/log.js';
import { cursorSessionArgs } from './session.js';
import { CursorStreamLogFilter } from './stream-log.js';
import { extractJsonPayload, extractResultField, runStreamingCli } from './stream-runner.js';
import { cursorProgressEvent } from './watchdog.js';
import { stripTrailingNewlines, type ProviderRuntime } from './runtime.js';

const CURSOR_STALL_RESUME_PROMPT =
  'The previous Cursor Agent turn in this same session was interrupted by the plan-loop watchdog because it stopped making progress within the configured limit.\n' +
  '\n' +
  'Continue the original task using the context already gathered in this session. Return the exact output requested by the original prompt and current output mode. Do not ask user questions. If enough evidence is already gathered, produce the final output now.\n';

export function cursorCliSupportsFlag(cursorBin: string, flag: string): boolean {
  const result = spawnSync(cursorBin, ['--help'], { encoding: 'utf8' });
  const combined = `${result.stdout || ''}${result.stderr || ''}`;
  return combined.includes(` ${flag}`);
}

interface CursorStreamOutcome {
  status: number;
  output: string;
}

async function cursorStream(
  rt: ProviderRuntime,
  promptText: string,
  args: readonly string[],
  captureFile: string,
): Promise<CursorStreamOutcome> {
  const filter = new CursorStreamLogFilter();
  const result = await runStreamingCli({
    command: rt.cursorBin,
    args: ['-p', '--output-format', 'stream-json', ...args],
    promptText,
    cwd: rt.projectRoot,
    knobs: rt.cursorKnobs,
    renderLine: (line) => filter.line(line),
    progressEvent: cursorProgressEvent,
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
    status = rt.cursorKnobs.stallStatus;
  }
  return { status, output };
}

type CursorMode = 'json' | 'markdown';

async function cursorStreamToFile(
  rt: ProviderRuntime,
  mode: CursorMode,
  promptText: string,
  outFile: string,
  args: readonly string[],
  captureFile: string,
): Promise<number> {
  const { status, output } = await cursorStream(rt, promptText, args, captureFile);
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
  const extracted = extractJsonPayload(output, {
    existsFile: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf8'),
  });
  writeFileSync(outFile, extracted.content);
  return 0;
}

async function cursorRunOnce(
  rt: ProviderRuntime,
  mode: CursorMode,
  promptText: string,
  outFile: string,
  sessionFile: string,
  invokeArgs: readonly string[],
): Promise<number> {
  const session = cursorSessionArgs(sessionFile);
  const wasResume = session.wasResume;
  let attemptedStallResume = false;
  const captureFile = sessionFile;

  rmSync(outFile, { force: true });
  let status = await cursorStreamToFile(
    rt,
    mode,
    promptText,
    outFile,
    [...session.args, ...invokeArgs],
    captureFile,
  );
  if (status === 0) {
    return 0;
  }

  const isStallWithLiveSession =
    status === rt.cursorKnobs.stallStatus && sessionFile !== '' && nonEmptyFile(sessionFile);
  if (isStallWithLiveSession) {
    log('WARNING: creator stream stalled; resuming the same cursor session once');
    const resumeArgs = ['--resume', readFileSync(sessionFile, 'utf8').trim()];
    attemptedStallResume = true;
    rmSync(outFile, { force: true });
    status = await cursorStreamToFile(
      rt,
      mode,
      CURSOR_STALL_RESUME_PROMPT,
      outFile,
      [...resumeArgs, ...invokeArgs],
      captureFile,
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
        rt,
        mode,
        promptText,
        outFile,
        [...freshSession.args, ...invokeArgs],
        captureFile,
      );
    }
  }

  return status;
}

export interface CursorInvokeInput {
  skillFile: string;
  tools: string;
  disallowedTools: string;
  model: string;
  sessionFile: string;
  schemaFile: string;
  promptBody: string;
}

interface CursorPromptAndArgs {
  args: string[];
  fullPrompt: string;
}

function cursorPromptAndArgs(rt: ProviderRuntime, input: CursorInvokeInput): CursorPromptAndArgs {
  const args = ['--workspace', rt.projectRoot, '--model', input.model];
  if (cursorCliSupportsFlag(rt.cursorBin, '--trust')) {
    args.push('--trust');
  }
  if (cursorCliSupportsFlag(rt.cursorBin, '--approve-mcps')) {
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
  rt: ProviderRuntime,
  mode: CursorMode,
  outFile: string,
  input: CursorInvokeInput,
): Promise<number> {
  const { args, fullPrompt } = cursorPromptAndArgs(rt, input);
  return cursorRunOnce(rt, mode, fullPrompt, outFile, input.sessionFile, args);
}
