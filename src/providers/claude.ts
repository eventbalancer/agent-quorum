import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { err, log } from '../runtime/log.js';
import { claudeSessionArgs } from './session.js';
import { StreamLogFilter } from './stream-log.js';
import { extractJsonPayload, extractResultField, runStreamingCli } from './stream-runner.js';
import { claudeProgressEvent } from './watchdog.js';
import type { ProviderRuntime } from './runtime.js';

const CLAUDE_STALL_RESUME_PROMPT =
  'The previous Claude Code CLI turn in this same session was interrupted by the plan-loop watchdog because it stopped making progress within the configured limit.\n' +
  '\n' +
  'Continue the original task using the context already gathered in this session. Return the exact output requested by the original prompt and current output mode. Do not ask user questions. If enough evidence is already gathered, produce the final output now.\n';

interface ClaudeStreamOutcome {
  status: number;
  output: string;
}

async function claudeStream(
  rt: ProviderRuntime,
  promptText: string,
  args: readonly string[],
): Promise<ClaudeStreamOutcome> {
  const filter = new StreamLogFilter();
  const result = await runStreamingCli({
    command: 'claude',
    args: ['-p', '--verbose', '--output-format', 'stream-json', ...args],
    promptText,
    cwd: rt.projectRoot,
    knobs: rt.claudeKnobs,
    renderLine: (line) => filter.line(line),
    progressEvent: claudeProgressEvent,
  });
  const output = extractResultField(result.streamLines, 'result');
  let status = result.status;
  if (result.stallReason !== undefined) {
    err(`claude stream stalled: ${result.stallReason}`);
    status = rt.claudeKnobs.stallStatus;
  }
  return { status, output };
}

type ClaudeMode = 'json' | 'markdown';

async function claudeStreamToFile(
  rt: ProviderRuntime,
  mode: ClaudeMode,
  promptText: string,
  outFile: string,
  args: readonly string[],
): Promise<number> {
  const { status, output } = await claudeStream(rt, promptText, args);
  if (mode === 'markdown') {
    writeFileSync(outFile, output);
    if (status !== 0) return status;
    if (output.length === 0) {
      err('claude produced no final result');
      return 4;
    }
    return 0;
  }

  if (status !== 0) return status;
  if (output.length === 0) {
    err('claude produced no final result');
    return 4;
  }
  const extracted = extractJsonPayload(output, {
    existsFile: (p) => existsSync(p),
    readFile: (p) => readFileSync(p, 'utf8'),
  });
  writeFileSync(outFile, extracted.content);
  return 0;
}

// Single-attempt claude call with session self-heal: on a stall with a live
// session, resume the same session once; on any further failure, drop the
// session file and re-establish a fresh session when this call was itself a
// resume. Transient-failure retries are owned by provider_run, not here.
async function claudeRunOnce(
  rt: ProviderRuntime,
  mode: ClaudeMode,
  promptText: string,
  outFile: string,
  sessionFile: string,
  invokeArgs: readonly string[],
): Promise<number> {
  const session = claudeSessionArgs(sessionFile);
  const wasResume = session.wasResume;
  let attemptedStallResume = false;

  rmSync(outFile, { force: true });
  let status = await claudeStreamToFile(rt, mode, promptText, outFile, [
    ...session.args,
    ...invokeArgs,
  ]);
  if (status === 0) return 0;

  const isStallWithLiveSession =
    status === rt.claudeKnobs.stallStatus && sessionFile !== '' && nonEmptyFile(sessionFile);
  if (isStallWithLiveSession) {
    log('WARNING: creator stream stalled; resuming the same session once');
    const resumeArgs = ['--resume', readFileSync(sessionFile, 'utf8').trim()];
    attemptedStallResume = true;
    rmSync(outFile, { force: true });
    status = await claudeStreamToFile(rt, mode, CLAUDE_STALL_RESUME_PROMPT, outFile, [
      ...resumeArgs,
      ...invokeArgs,
    ]);
    if (status === 0) return 0;
  }

  if (sessionFile !== '') {
    rmSync(sessionFile, { force: true });
    if (wasResume || attemptedStallResume) {
      log('WARNING: creator session resume failed; re-establishing session');
      const freshSession = claudeSessionArgs(sessionFile);
      rmSync(outFile, { force: true });
      return claudeStreamToFile(rt, mode, promptText, outFile, [
        ...freshSession.args,
        ...invokeArgs,
      ]);
    }
  }

  return status;
}

// Argument contract for one claude call. Plan mode is the default permission
// mode; the translator overrides it to "default" because its stdout IS the
// artifact and plan mode's framing collides with that.
function claudeInvokeArgs(
  rt: ProviderRuntime,
  skillFile: string,
  tools: string,
  disallowedTools: string,
  model: string,
  effort: string,
  schemaFile?: string,
): string[] {
  const permissionMode = rt.claudePermissionMode ?? process.env.CLAUDE_PERMISSION_MODE ?? 'plan';
  const args = [
    '--append-system-prompt',
    readFileSync(skillFile, 'utf8').replace(/\n+$/, ''),
    '--permission-mode',
    permissionMode,
    '--model',
    model,
  ];
  if (schemaFile !== undefined && schemaFile !== '') {
    args.push('--json-schema', readFileSync(schemaFile, 'utf8').replace(/\n+$/, ''));
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
  rt: ProviderRuntime,
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
): Promise<number> {
  const args = claudeInvokeArgs(rt, skillFile, tools, disallowedTools, model, effort, schemaFile);
  return claudeRunOnce(rt, mode, promptText, outFile, sessionFile, args);
}
