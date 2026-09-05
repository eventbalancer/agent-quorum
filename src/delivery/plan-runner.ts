import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { buildSystemContext } from '../core/system-context.js';
import { fileSha256 } from '../core/digest.js';
import { collectPlanningArtifacts, planningArtifactsNeedDecoder } from './evidence-artifacts.js';
import {
  decodeApprovedPlanningArtifacts,
  type EvidenceDecoderContext,
} from './evidence-decoder-registry.js';
import { admitFinalPlan } from '../core/plan-admission.js';
import { readRunRecords } from '../core/run-store.js';
import { resolveArtifactRoots } from '../runtime/paths.js';
import type { ExecutionControl } from '../runtime/execution-control.js';
import { runPlanLoopCli } from '../stages/plan/run.js';
import {
  contentDigest,
  digest,
  DeliveryError,
  type DeliveryIssue,
  type Mandate,
} from './contract.js';
import { readPlanningConfig } from './worker.js';

export interface DeliveryPlanResult {
  readonly workDir: string;
  readonly canonicalPlanSha256: string;
  readonly planPath: string;
}

export async function runDeliveryPlan(
  mandate: Mandate,
  issue: DeliveryIssue,
  workDir: string,
  execution: ExecutionControl,
  decoderContext?: EvidenceDecoderContext,
  run: typeof runPlanLoopCli = runPlanLoopCli,
): Promise<DeliveryPlanResult> {
  if (issue.worktree === undefined) {
    throw new DeliveryError('planning-worktree-missing');
  }
  mkdirSync(path.dirname(workDir), { recursive: true, mode: 0o700 });
  const inputPath = `${workDir}.prompt.md`;
  const inputText = [
    `# ${issue.title}`,
    `Issue: ${mandate.repository}#${issue.number}`,
    '## Current problem',
    issue.currentBody ?? issue.originalBody,
    '## Original issue evidence',
    `Original title: ${issue.originalTitle ?? issue.title}`,
    issue.originalBody,
    '## Observable acceptance',
    JSON.stringify(issue.acceptance, null, 2),
    '## Recorded decisions',
    ...issue.decisions,
    'Produce an implementation-ready plan preserving the complete problem outcome. Resolve product and technical choices within the repository purpose. Compatibility is not required. Releases, permission expansion, and weakened verification are excluded.',
  ].join('\n\n');
  const home = `${workDir}.home`;
  const identityFile = `${workDir}.identity.json`;
  const hasPriorAttempt = existsSync(identityFile);
  if (hasPriorAttempt) {
    if (!existsSync(inputPath) || readFileSync(inputPath, 'utf8') !== inputText) {
      throw new DeliveryError('design-plan-input-changed');
    }
  } else {
    if (existsSync(inputPath) || existsSync(workDir) || existsSync(home)) {
      throw new DeliveryError('design-attempt-provenance-missing');
    }
    writeFileSync(inputPath, inputText, { mode: 0o400, flag: 'wx' });
  }
  const inputDigest = contentDigest(inputText);
  const config = readPlanningConfig(mandate);
  const systemDigest = buildSystemContext({
    projectRoot: issue.worktree,
    mode: 'prompt',
    inputFile: inputPath,
  }).digest;
  const identity = {
    schemaVersion: 1,
    inputDigest,
    configDigest: digest(config),
    systemDigest,
    baseSha: issue.baseSha,
    controllerDigest: mandate.controllerDigest,
    profileDigest: mandate.profileDigest,
    quality: mandate.profile.planning.quality,
    maxIterations: mandate.profile.planning.maxIterations,
  };
  if (hasPriorAttempt) {
    const recorded: unknown = JSON.parse(readFileSync(identityFile, 'utf8'));
    if (digest(recorded) !== digest(identity)) {
      throw new DeliveryError('design-attempt-inputs-changed');
    }
    if (!existsSync(workDir)) {
      throw new DeliveryError('design-attempt-incomplete');
    }
    return admitDeliveryPlanArtifacts(
      workDir,
      path.join(home, 'state'),
      inputPath,
      inputDigest,
      execution,
      decoderContext,
      systemDigest,
    );
  }
  writeFileSync(identityFile, JSON.stringify(identity), { mode: 0o400, flag: 'wx' });
  const inheritedConfiguration = Object.fromEntries(
    Object.entries(process.env).filter(([name]) => name.startsWith('AGENT_QUORUM_')),
  );
  const overrides = {
    home,
    workDir,
    config: { ...config, telegram: { ...config.telegram, clarify: 'off' as const } },
  };
  const previousDirectory = process.cwd();
  try {
    process.chdir(issue.worktree);
    for (const name of Object.keys(inheritedConfiguration)) {
      Reflect.deleteProperty(process.env, name);
    }
    const result = await run(
      [
        '--prompt',
        inputPath,
        '--quality',
        mandate.profile.planning.quality,
        '--iters',
        String(mandate.profile.planning.maxIterations),
      ],
      overrides,
      execution,
    );
    if (result.exitCode !== 0) {
      throw new DeliveryError('design-planning-failed');
    }
    return await admitDeliveryPlanArtifacts(
      workDir,
      resolveArtifactRoots({ home }).stateDir,
      inputPath,
      inputDigest,
      execution,
      decoderContext,
      systemDigest,
    );
  } finally {
    process.chdir(previousDirectory);
    for (const name of Object.keys(process.env).filter((key) => key.startsWith('AGENT_QUORUM_'))) {
      Reflect.deleteProperty(process.env, name);
    }
    Object.assign(process.env, inheritedConfiguration);
  }
}

export async function admitDeliveryPlanArtifacts(
  workDir: string,
  stateDir: string,
  inputPath: string,
  expectedInputDigest: string,
  execution: ExecutionControl,
  decoderContext?: EvidenceDecoderContext,
  expectedAuthoritativeDigest?: string,
): Promise<DeliveryPlanResult> {
  if (fileSha256(inputPath) !== expectedInputDigest) {
    throw new DeliveryError('design-plan-input-changed');
  }
  const records = readRunRecords(stateDir).filter((record) => {
    try {
      return realpathSync(record.workDir) === realpathSync(workDir);
    } catch {
      return false;
    }
  });
  const record = records[0];
  const admission =
    records.length === 1 && record !== undefined
      ? admitFinalPlan({
          workDir,
          record,
          expectedSourceDigest: expectedInputDigest,
          ...(expectedAuthoritativeDigest === undefined ? {} : { expectedAuthoritativeDigest }),
        })
      : undefined;
  const planPath = path.join(workDir, 'plan.final.md');
  if (admission?.admitted === true) {
    return { workDir, planPath, canonicalPlanSha256: admission.canonicalPlanSha256 };
  }
  const input = collectPlanningArtifacts(workDir, stateDir, inputPath);
  if (!planningArtifactsNeedDecoder(input)) {
    throw new DeliveryError('design-plan-not-ready');
  }
  if (decoderContext === undefined) {
    throw new DeliveryError('evidence-decoder-not-approved');
  }
  await decodeApprovedPlanningArtifacts(
    decoderContext,
    input,
    execution,
    (projectedWorkDir, projectedStateDir) => {
      const projected = readRunRecords(projectedStateDir)[0];
      if (
        projected === undefined ||
        !admitFinalPlan({
          workDir: projectedWorkDir,
          record: projected,
          expectedSourceDigest: expectedInputDigest,
          ...(expectedAuthoritativeDigest === undefined ? {} : { expectedAuthoritativeDigest }),
        }).admitted
      ) {
        throw new DeliveryError('design-plan-context-changed');
      }
    },
  );
  return { workDir, planPath, canonicalPlanSha256: fileSha256(planPath) };
}
