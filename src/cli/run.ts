import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { accessSync, constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadPlanLoopDotenv, packageRoot, projectRoot } from '../runtime/env.js';
import { fileLineCount } from '../runtime/files.js';
import { installSignalTeardown } from '../runtime/exec.js';
import { ownPgid } from '../runtime/exec.js';
import { HaltError } from '../runtime/halt.js';
import { err, log } from '../runtime/log.js';
import { Scratch } from '../runtime/scratch.js';
import {
  cleanupRunRegistry,
  nowUtcStamp,
  writeRunMetadata,
  type RunMetadata,
} from '../core/artifacts.js';
import { runClarificationGate } from '../core/clarify.js';
import {
  configFilePath,
  resolveRoleConfig,
  resolveRolePermissions,
  resolveRunSettings,
  runnersInUse,
  type CliSettings,
} from '../core/config.js';
import { runCreatorCreate } from '../core/creator.js';
import { effortMatrix } from '../core/effort.js';
import { runFixPass } from '../core/fix-pass.js';
import { markOperatorInterventionsMigrated } from '../core/interventions.js';
import { resolveWatchdogKnobs } from '../core/knobs.js';
import { runIterationLoop } from '../core/loop.js';
import { planDocumentShapeHealth, planHasTitleHeading } from '../core/plan-shape.js';
import { prepareResume } from '../core/resume.js';
import { skillPaths, type RunContext } from '../core/run-context.js';
import { writeSummary } from '../core/summary.js';
import { runTranslatePass } from '../core/translate-pass.js';
import { readFindingsCounts, validateFinalPlan } from '../core/validate-plan.js';
import type { RunMode } from '../types.js';

const USAGE =
  'usage: plan-loop.sh [--iters N] [--effort {low,high,max}] [--no-fix] [--no-translate] <plan.md>\n' +
  '       plan-loop.sh [--iters N] [--effort {low,high,max}] [--no-fix] [--no-translate] --prompt <prompt.md>\n';

function usage(): never {
  process.stderr.write(USAGE);
  throw new HaltError('usage', 1, true);
}

export interface ParsedRunArgs {
  mode: RunMode;
  inputPath: string;
  cli: CliSettings;
}

export function parseRunArgs(args: readonly string[]): ParsedRunArgs {
  let mode: RunMode = 'plan';
  let inputPath = '';
  const cli: CliSettings = {};

  let i = 0;
  const usageError = (message: string): never => {
    process.stderr.write(`${message}\n`);
    throw new HaltError(message, 1, true);
  };
  parse: while (i < args.length) {
    const arg = args[i] ?? '';
    switch (true) {
      case arg === '--prompt': {
        mode = 'prompt';
        const value = args[i + 1] ?? '';
        if (value === '') usage();
        inputPath = value;
        i += 2;
        break;
      }
      case arg === '--iters' || arg === '--max-iters': {
        const value = args[i + 1] ?? '';
        if (!/^[0-9]+$/.test(value)) usageError('--iters expects a positive integer');
        cli.maxIters = value;
        i += 2;
        break;
      }
      case arg.startsWith('--iters=') || arg.startsWith('--max-iters='): {
        const value = arg.slice(arg.indexOf('=') + 1);
        if (!/^[0-9]+$/.test(value)) usageError('--iters expects a positive integer');
        cli.maxIters = value;
        i += 1;
        break;
      }
      case arg === '--fix':
        cli.fix = '1';
        i += 1;
        break;
      case arg === '--no-fix':
        cli.fix = '0';
        i += 1;
        break;
      case arg === '--translate':
        cli.translate = '1';
        i += 1;
        break;
      case arg === '--no-translate':
        cli.translate = '0';
        i += 1;
        break;
      case arg === '--effort': {
        const value = args[i + 1] ?? '';
        if (value === '') usageError('--effort expects low, high, or max');
        cli.effort = value;
        i += 2;
        break;
      }
      case arg.startsWith('--effort='):
        cli.effort = arg.slice('--effort='.length);
        i += 1;
        break;
      case arg === '-h' || arg === '--help':
        usage();
        break;
      case arg === '--':
        break parse;
      case arg.startsWith('-'):
        process.stderr.write(`unknown flag: ${arg}\n`);
        usage();
        break;
      default:
        if (inputPath !== '') {
          process.stderr.write(`unexpected arg: ${arg}\n`);
          usage();
        }
        inputPath = arg;
        i += 1;
        break;
    }
  }

  if (inputPath === '') usage();
  if (!existsSync(inputPath) || !statSync(inputPath).isFile()) {
    process.stderr.write(`file not found: ${inputPath}\n`);
    throw new HaltError(`file not found: ${inputPath}`, 1, true);
  }
  return { mode, inputPath, cli };
}

function commandExists(name: string): boolean {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    if (dir === '') continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return true;
    } catch {
      /* keep scanning */
    }
  }
  return false;
}

function canonicalDir(dir: string): string {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

function absolutePath(file: string): string {
  return path.join(canonicalDir(path.dirname(path.resolve(file))), path.basename(file));
}

function filesEqual(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false;
  return readFileSync(a).equals(readFileSync(b));
}

export async function runPlanLoopCli(args: readonly string[]): Promise<number> {
  loadPlanLoopDotenv();
  const parsed = parseRunArgs(args);

  const settings = resolveRunSettings(parsed.cli, configFilePath());
  const knobs = resolveWatchdogKnobs();
  const effort = effortMatrix(settings.effort);

  const plansDir = process.env.PLAN_LOOP_PLANS_DIR ?? path.join(os.homedir(), '.claude', 'plans');
  const inputPath = absolutePath(parsed.inputPath);
  const base = path.basename(inputPath, '.md');
  let work = process.env.PLAN_LOOP_WORK_DIR ?? path.join(plansDir, `loop-${base}`);
  if (!path.isAbsolute(work)) work = path.join(process.cwd(), work);
  mkdirSync(work, { recursive: true });
  work = canonicalDir(work);
  let runStateDir = process.env.PLAN_LOOP_STATE_DIR ?? path.join(plansDir, '.runs');
  if (!path.isAbsolute(runStateDir)) runStateDir = path.join(process.cwd(), runStateDir);
  mkdirSync(runStateDir, { recursive: true });
  runStateDir = canonicalDir(runStateDir);
  const runMetaFile = path.join(work, 'run.meta.tsv');
  const runRegistryFile = path.join(runStateDir, `${process.pid}.tsv`);

  const matrix = resolveRoleConfig(configFilePath());
  const permissions = resolveRolePermissions(configFilePath());

  const metadata: RunMetadata = {
    pid: process.pid,
    pgid: ownPgid(),
    mode: parsed.mode,
    inputPath,
    workDir: work,
    plansDir,
    startedAt: nowUtcStamp(),
    effort: settings.effort,
    sessionMode: String(effort.sessionMode),
    creatorOneShot: String(effort.creatorOneShot),
    previousCritiques: effort.previousCritiques,
    topology: effort.topology,
    maxIters: settings.maxIters,
    fixPass: String(settings.fixPass),
    diffThreshold: settings.diffThreshold,
    critic: {
      runner: matrix.critic.runner,
      model: matrix.critic.model,
      reasoning: matrix.critic.reasoning,
      tools: permissions.critic.tools,
      disallowedTools: permissions.critic.disallowedTools,
    },
    creator: {
      runner: matrix.creator.runner,
      model: matrix.creator.model,
      reasoning: matrix.creator.reasoning,
      createTools: permissions.creator.createTools,
      createDisallowedTools: permissions.creator.createDisallowedTools,
      updateTools: permissions.creator.updateTools,
      updateDisallowedTools: permissions.creator.updateDisallowedTools,
    },
    fixer: {
      runner: matrix.fixer.runner,
      model: matrix.fixer.model,
      reasoning: matrix.fixer.reasoning,
      tools: permissions.fixer.tools,
      disallowedTools: permissions.fixer.disallowedTools,
    },
    reviewer: {
      runner: matrix.reviewer.runner,
      model: matrix.reviewer.model,
      reasoning: matrix.reviewer.reasoning,
      tools: permissions.reviewer.tools,
      disallowedTools: permissions.reviewer.disallowedTools,
    },
  };
  writeRunMetadata(runMetaFile, runRegistryFile, metadata);

  const skills = skillPaths(packageRoot());
  for (const skillFile of [
    skills.criticSkill,
    skills.criticSchema,
    skills.creatorSkill,
    skills.creatorSchema,
    skills.creatorMetaSchema,
    skills.clarifySchema,
    skills.fixerSkill,
    skills.reviewerSkill,
    skills.reviewerSchema,
    skills.translatorSkill,
    skills.markdownSchema,
  ]) {
    if (!existsSync(skillFile)) {
      process.stderr.write(`missing: ${skillFile}\n`);
      cleanupRunRegistry(runRegistryFile);
      return 1;
    }
  }

  const cursorBin = process.env.PLAN_LOOP_CURSOR_BIN ?? 'cursor-agent';
  const required = runnersInUse(matrix, settings.fixPass, settings.translatePass);
  for (const runner of required) {
    if (runner === 'codex' && !commandExists('codex')) {
      process.stderr.write('codex is required\n');
      cleanupRunRegistry(runRegistryFile);
      return 1;
    }
    if (runner === 'claude' && !commandExists('claude')) {
      process.stderr.write('claude is required\n');
      cleanupRunRegistry(runRegistryFile);
      return 1;
    }
    if (runner === 'cursor' && !commandExists(cursorBin)) {
      process.stderr.write('cursor-agent is required\n');
      cleanupRunRegistry(runRegistryFile);
      return 1;
    }
  }

  const scratch = Scratch.create(base);
  const creatorSessionFile = path.join(work, 'creator.session-id');

  const ctx: RunContext = {
    work,
    mode: parsed.mode,
    inputPath,
    plansDir,
    settings,
    effort,
    permissions,
    skills,
    provider: {
      scratch,
      projectRoot: projectRoot(),
      retry: { retryCount: settings.retryCount, retryDelaySeconds: settings.retryDelaySeconds },
      claudeKnobs: knobs.claude,
      cursorKnobs: knobs.cursor,
      matrix,
      sessionMode: effort.sessionMode,
      creatorSessionFile,
      markdownSchemaPath: skills.markdownSchema,
      cursorBin,
    },
    passes: { fixPass: knobs.fixPass, translatePass: knobs.translatePass },
    maxPlanLines: Number(process.env.PLAN_LOOP_MAX_PLAN_LINES ?? 900),
    lastCritiqueIter: -1,
    resume: { startIter: 0, archivedCount: 0, archiveDir: '' },
  };

  const cleanup = () => {
    cleanupRunRegistry(runRegistryFile);
    scratch.sweep();
  };
  installSignalTeardown(cleanup);

  try {
    if (effort.sessionMode === 1) {
      rmSync(creatorSessionFile, { force: true });
    }
    const rejectedLog = path.join(work, 'rejected-log.jsonl');
    if (!existsSync(rejectedLog)) writeFileSync(rejectedLog, '');

    if (parsed.mode === 'prompt') {
      const promptCopy = path.join(work, 'prompt.md');
      if (!filesEqual(inputPath, promptCopy)) {
        copyFileSync(inputPath, promptCopy);
      }
      const v0 = path.join(work, 'plan.v0.md');
      if (!existsSync(v0) || statSync(v0).size === 0) {
        const gateOk = await runClarificationGate(ctx, inputPath);
        if (!gateOk) return 7;
        log(`creating plan v0 from prompt (${matrix.creator.runner} ${matrix.creator.model})`);
        await runCreatorCreate(ctx, inputPath, v0);
        markOperatorInterventionsMigrated(work, 'creator', 'plan.v0.md');
        log(`  → plan.v0.md created (${fileLineCount(v0)} lines)`);
      }
    } else {
      const v0 = path.join(work, 'plan.v0.md');
      if (!existsSync(v0)) copyFileSync(inputPath, v0);
    }

    let startIter = 0;
    if (process.env.PLAN_LOOP_RESUME === '1') {
      startIter = prepareResume(ctx);
    }
    if (startIter > 0) log(`resuming from v${startIter}`);

    const { iter } = await runIterationLoop(ctx, startIter);

    const finalPlan = path.join(work, 'plan.final.md');
    validateFinalPlan(ctx.provider.projectRoot, finalPlan);

    if (settings.fixPass === 1) {
      await runFixPass(ctx, finalPlan);
    } else {
      log('fix-pass: disabled via --no-fix');
    }

    const shape = planDocumentShapeHealth(finalPlan);
    const finalTitle = planHasTitleHeading(finalPlan) ? 1 : 0;
    const findings = readFindingsCounts(path.join(work, 'findings.json'));
    let finalStatus = 'clean';
    let finalReason = '';
    if (finalTitle !== 1 || shape.missing !== 0 || shape.graph !== 1) {
      finalStatus = 'blocked';
      finalReason = `plan shape broken (title=${finalTitle} missing_sections=${shape.missing} impact_graph_mermaid=${shape.graph})`;
    } else if (findings.stale > 0) {
      finalStatus = 'needs-review';
      finalReason = `${findings.stale} stale line reference(s) remain after fix-pass`;
    } else if (findings.ambiguous > 0 || findings.unresolved > 0) {
      finalStatus = 'needs-review';
      finalReason = `${findings.ambiguous} ambiguous + ${findings.unresolved} unresolved reference(s) (may be generic names or future files)`;
    }
    if (finalStatus === 'clean') {
      log('FINAL: clean — plan.final.md is structurally complete with no stale references');
    } else {
      err(`FINAL: ${finalStatus} — ${finalReason}`);
    }

    const translateRuFile = path.join(work, 'plan.final.ru.md');
    if (settings.translatePass === 1) {
      await runTranslatePass(ctx, finalPlan, translateRuFile);
    } else {
      log('translate-pass: disabled via --no-translate');
    }

    writeSummary(ctx, {
      iter,
      finalRuFile: translateRuFile,
      finalStale: findings.stale,
      finalAmbiguous: findings.ambiguous,
      finalUnresolved: findings.unresolved,
      finalStatus,
      finalReason,
    });

    log(`done. summary: ${path.join(work, 'summary.md')}`);
    if (finalStatus === 'blocked') return 6;
    return 0;
  } finally {
    cleanup();
  }
}
