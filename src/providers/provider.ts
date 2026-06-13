import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { nonEmptyFile } from '../runtime/files.js';
import { err, log } from '../runtime/log.js';
import { runWithRetries } from '../runtime/retry.js';
import { isJsonObject, type JsonValue } from '../core/json.js';
import type { Role } from '../types.js';
import { codexRun } from './codex.js';
import { claudeInvoke } from './claude.js';
import { cursorInvoke } from './cursor.js';
import { createDiagnosticSink, type DiagnosticSink, type TraceContext } from './trace.js';
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
): Promise<number> {
  const entry = providerRuntime.matrix[role];
  const sessionFile = roleSessionFile(providerRuntime, role);
  const traceContext: TraceContext = { role, provider: entry.runner, model: entry.model };
  const diagnosticSink =
    providerRuntime.diagnosticsDir !== undefined
      ? createDiagnosticSink(providerRuntime.diagnosticsDir, traceContext)
      : undefined;
  try {
    switch (entry.runner) {
      case 'codex':
        return await providerRunCodex(
          providerRuntime,
          mode,
          outFile,
          skillFile,
          schemaFile,
          entry.model,
          entry.reasoning,
          promptText,
          traceContext,
          diagnosticSink,
        );
      case 'claude':
        return await claudeInvoke(
          providerRuntime,
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
          traceContext,
          diagnosticSink,
        );
      case 'cursor': {
        if (entry.reasoning !== '') {
          log(
            `WARNING: cursor runner ignores reasoning/effort field (reasoning=${entry.reasoning})`,
          );
        }
        return await cursorInvoke(
          providerRuntime,
          mode,
          outFile,
          {
            skillFile,
            tools,
            disallowedTools,
            model: entry.model,
            sessionFile,
            schemaFile: mode === 'json' ? schemaFile : '',
            promptBody: promptText,
          },
          traceContext,
          diagnosticSink,
        );
      }
      default: {
        const unknownRunner: never = entry.runner;
        err(`provider_run: unknown runner '${unknownRunner as string}'`);
        return 2;
      }
    }
  } finally {
    diagnosticSink?.close();
  }
}

export async function providerRun(
  providerRuntime: ProviderRuntime,
  role: Role,
  mode: ProviderMode,
  outFile: string,
  skillFile: string,
  schemaFile: string,
  tools: string,
  disallowedTools: string,
  promptText: string,
): Promise<number> {
  const runner = providerRuntime.matrix[role].runner;
  return runWithRetries(`${runner} call`, providerRuntime.retry, () => {
    return providerRunOnce(
      providerRuntime,
      role,
      mode,
      outFile,
      skillFile,
      schemaFile,
      tools,
      disallowedTools,
      promptText,
    );
  });
}
