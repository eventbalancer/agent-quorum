import { readFileSync, rmSync } from 'node:fs';
import { fileLineCount, nonEmptyFile } from '../../runtime/files.js';
import { err, log } from '../../runtime/log.js';
import { providerRun } from '../../providers/provider.js';
import type { ProviderRuntime } from '../../providers/runtime.js';
import { readStripped, type RunContext } from '../../core/run-context.js';
import { retainedRolePrompt } from './retained-context.js';

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
    streamKnobs: {
      ...ctx.provider.streamKnobs,
      claude: {
        ...ctx.provider.streamKnobs.claude,
        wallTimeoutSeconds: ctx.passes.translatePass.timeoutSeconds,
        semanticTimeoutSeconds: ctx.passes.translatePass.semanticIdleTimeoutSeconds,
      },
      cursor: {
        ...ctx.provider.streamKnobs.cursor,
        wallTimeoutSeconds: ctx.passes.translatePass.timeoutSeconds,
        semanticTimeoutSeconds: ctx.passes.translatePass.semanticIdleTimeoutSeconds,
      },
    },
    claudePermissionMode: 'default',
  };
}

function frontmatterBlock(markdown: string): string | undefined {
  return /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(markdown)?.[0];
}

function durableIds(markdown: string): string[] {
  return (markdown.match(/\b(?:I-v[0-9]+-C[0-9]+|[OR]-[a-f0-9]{64})\b/g) ?? []).sort();
}

function systemCoverageTable(markdown: string): string | undefined {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => line.trim() === '## System Coverage');
  if (start < 0) {
    return undefined;
  }
  const endOffset = lines.slice(start + 1).findIndex((line) => /^##\s+/.test(line));
  const end = endOffset < 0 ? lines.length : start + 1 + endOffset;
  const table = lines
    .slice(start + 1, end)
    .filter((line) => line.trimStart().startsWith('|'))
    .join('\n');
  return table === '' ? undefined : table;
}

function translatedPlanPreservesContracts(canonical: string, translated: string): boolean {
  const canonicalFrontmatter = frontmatterBlock(canonical);
  const translatedFrontmatter = frontmatterBlock(translated);
  if (canonicalFrontmatter === undefined || translatedFrontmatter !== canonicalFrontmatter) {
    return false;
  }
  if (JSON.stringify(durableIds(translated)) !== JSON.stringify(durableIds(canonical))) {
    return false;
  }
  const coverage = systemCoverageTable(canonical);
  return coverage === undefined || translated.includes(coverage);
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
  const basePrompt = `## Target locale\n${locale}\n` + '\n' + `## Plan\n${readStripped(finalPlan)}`;
  const translatePrompt = retainedRolePrompt({
    ctx,
    role: 'translator',
    stage: 'translate',
    planVersion: ctx.convergence.planVersion,
    skillFile: ctx.skills.translatorSkill,
    schemaFile: '',
    basePrompt,
    persistVersionedState: false,
  });

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

  const canonical = readFileSync(finalPlan, 'utf8');
  const translated = readFileSync(outFile, 'utf8');
  if (!translatedPlanPreservesContracts(canonical, translated)) {
    err(
      'translate-pass: rejected localized output — frontmatter, durable identifiers, or System Coverage changed',
    );
    rmSync(outFile, { force: true });
    return;
  }

  log(`translate-pass:   → ${outFile} created (${fileLineCount(outFile)} lines)`);
  log('translate-pass: done');
}
