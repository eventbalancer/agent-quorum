import { rmSync } from 'node:fs';
import { fileLineCount, nonEmptyFile } from '../../runtime/files.js';
import { err, log } from '../../runtime/log.js';
import { providerRun } from '../../providers/provider.js';
import type { ProviderRuntime } from '../../providers/runtime.js';
import { readStripped, type RunContext } from '../../core/run-context.js';

// The translator overrides claude AND cursor timeouts plus the retry count,
// and runs claude with --permission-mode default: its stdout IS the artifact,
// and plan mode's "present a plan" framing collides with that.
function translateRuntime(ctx: RunContext): ProviderRuntime {
  return {
    ...ctx.provider,
    retry: {
      retryCount: ctx.passes.translatePass.retryCount,
      retryDelaySeconds: ctx.provider.retry.retryDelaySeconds,
    },
    claudeKnobs: {
      ...ctx.provider.claudeKnobs,
      wallTimeoutSeconds: ctx.passes.translatePass.timeoutSeconds,
      semanticTimeoutSeconds: ctx.passes.translatePass.semanticIdleTimeoutSeconds,
    },
    cursorKnobs: {
      ...ctx.provider.cursorKnobs,
      wallTimeoutSeconds: ctx.passes.translatePass.timeoutSeconds,
      semanticTimeoutSeconds: ctx.passes.translatePass.semanticIdleTimeoutSeconds,
    },
    claudePermissionMode: 'default',
  };
}

// Non-fatal: a failed translation logs a warning and leaves the English
// plan.final.md untouched.
export async function runTranslatePass(
  ctx: RunContext,
  finalPlan: string,
  outFile: string,
): Promise<void> {
  const rt = translateRuntime(ctx);
  const locale = ctx.settings.locale;

  if (!nonEmptyFile(finalPlan)) {
    log('translate-pass: no final plan — skipping');
    return;
  }

  log(
    `translate-pass: ${rt.matrix.translator.runner} translate to ${locale} (${rt.matrix.translator.model} reasoning=${rt.matrix.translator.reasoning})`,
  );
  const translatePrompt =
    `## Target locale\n${locale}\n` + '\n' + `## Plan\n${readStripped(finalPlan)}`;

  const status = await providerRun(
    rt,
    'translator',
    'markdown',
    outFile,
    ctx.skills.translatorSkill,
    '',
    ctx.permissions.translator.tools,
    ctx.permissions.translator.disallowedTools,
    translatePrompt,
  );

  if (status !== 0 || !nonEmptyFile(outFile)) {
    err(
      `translate-pass: failed/timed out (status=${status}) — localized plan not produced; English plan.final.md unaffected`,
    );
    rmSync(outFile, { force: true });
    return;
  }

  log(`translate-pass:   → ${outFile} created (${fileLineCount(outFile)} lines)`);
  log('translate-pass: done');
}
