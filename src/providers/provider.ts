import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { err, log } from '../runtime/log.js';
import { runWithRetries } from '../runtime/retry.js';
import { isJsonObject, type JsonValue } from '../core/json.js';
import type { Role } from '../types.js';
import { codexRun } from './codex.js';
import { claudeInvoke } from './claude.js';
import { cursorInvoke } from './cursor.js';
import { roleSessionFile, stripTrailingNewlines, type ProviderRuntime } from './runtime.js';

export type ProviderMode = 'json' | 'markdown';

async function providerRunCodex(
  rt: ProviderRuntime,
  mode: ProviderMode,
  outFile: string,
  skillFile: string,
  schemaFile: string,
  model: string,
  reasoning: string,
  promptText: string,
): Promise<number> {
  const skill = stripTrailingNewlines(readFileSync(skillFile, 'utf8'));
  const fullPrompt = `${skill}\n\n${stripTrailingNewlines(promptText)}`;
  if (mode === 'json') {
    return codexRun(rt, model, reasoning, schemaFile, outFile, fullPrompt);
  }

  const wrap = rt.scratch.file();
  const status = await codexRun(rt, model, reasoning, rt.markdownSchemaPath, wrap, fullPrompt);
  if (status !== 0) {
    rmSync(wrap, { force: true });
    return status;
  }
  // jq -r '.plan_markdown' over the wrapper: a string renders raw, anything
  // else renders as JSON, parse failure leaves the output empty.
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

async function providerRunOnce(
  rt: ProviderRuntime,
  role: Role,
  mode: ProviderMode,
  outFile: string,
  skillFile: string,
  schemaFile: string,
  tools: string,
  disallowedTools: string,
  promptText: string,
): Promise<number> {
  const entry = rt.matrix[role];
  const sessionFile = roleSessionFile(rt, role);
  switch (entry.runner) {
    case 'codex':
      return providerRunCodex(
        rt,
        mode,
        outFile,
        skillFile,
        schemaFile,
        entry.model,
        entry.reasoning,
        promptText,
      );
    case 'claude':
      return claudeInvoke(
        rt,
        mode,
        outFile,
        skillFile,
        tools,
        disallowedTools,
        entry.model,
        entry.reasoning,
        sessionFile,
        mode === 'json' ? schemaFile : undefined,
        promptText,
      );
    case 'cursor': {
      if (entry.reasoning !== '') {
        log(`WARNING: cursor runner ignores reasoning/effort field (reasoning=${entry.reasoning})`);
      }
      return cursorInvoke(rt, mode, outFile, {
        skillFile,
        tools,
        disallowedTools,
        model: entry.model,
        sessionFile,
        schemaFile: mode === 'json' ? schemaFile : '',
        promptBody: promptText,
      });
    }
    default:
      err(`provider_run: unknown runner '${entry.runner as string}'`);
      return 2;
  }
}

// The single adapter every role uses to call its runner; owns the one and only
// retry wrapper.
export async function providerRun(
  rt: ProviderRuntime,
  role: Role,
  mode: ProviderMode,
  outFile: string,
  skillFile: string,
  schemaFile: string,
  tools: string,
  disallowedTools: string,
  promptText: string,
): Promise<number> {
  const runner = rt.matrix[role].runner;
  return runWithRetries(`${runner} call`, rt.retry, () =>
    providerRunOnce(
      rt,
      role,
      mode,
      outFile,
      skillFile,
      schemaFile,
      tools,
      disallowedTools,
      promptText,
    ),
  );
}
