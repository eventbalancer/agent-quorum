import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { canonicalJsonSha256, sha256 } from '../../src/core/digest.js';
import type { JsonObject } from '../../src/core/json.js';
import { projectCodexJsonSchema } from '../../src/providers/codex-schema.js';
import { runFrozenSmokeDriver } from '../../src/delivery/live-driver.js';
import {
  LiveProviderJournal,
  liveProvenancePath,
  type LiveProviderProvenance,
} from '../../src/delivery/live-provenance.js';
import { REPO_ROOT } from '../helpers/harness.js';

const directories: string[] = [];
function temporary(): string {
  const root = mkdtempSync(path.join(os.tmpdir(), 'delivery-provenance-'));
  directories.push(root);
  return root;
}
afterEach(() => {
  directories.splice(0).forEach((root) => {
    rmSync(root, { recursive: true, force: true });
  });
});

function journal(root: string): LiveProviderJournal {
  mkdirSync(path.join(root, 'attempt'));
  return new LiveProviderJournal(
    {
      id: 'required-critic',
      inputMode: 'plan',
      quality: 'balanced',
      maxIterations: 3,
      inputSha256: sha256('input'),
      workDir: path.join(root, 'attempt/run'),
      repositoryRoot: root,
      controllerDigest: 'controller',
      profileDigest: 'profile',
      providerConfigSha256: 'config',
      workspaceRevision: 'a'.repeat(40),
      attemptIdentity: 'b'.repeat(64),
    },
    REPO_ROOT,
  );
}

describe('host-owned live provider provenance', () => {
  it('durably binds actual starts and output bytes outside the candidate attempt mount', () => {
    const root = temporary();
    const recorded = journal(root);
    const skill = readFileSync(path.join(REPO_ROOT, 'skills/plan-critic/SKILL.md'), 'utf8').replace(
      /\n+$/,
      '',
    );
    const schema = projectCodexJsonSchema(
      JSON.parse(
        readFileSync(path.join(REPO_ROOT, 'skills/plan-critic/critique.schema.json'), 'utf8'),
      ) as JsonObject,
    ).schema;
    const prompt = `${skill}\n\nReview the fixture plan`;
    const id = recorded.request({ model: 'fixture', reasoning: 'high', prompt, schema });
    const before = JSON.parse(readFileSync(recorded.file, 'utf8')) as LiveProviderProvenance;
    expect(before.calls[0]?.starts).toEqual([]);
    expect(before.calls[0]?.output).toBeUndefined();
    recorded.started(id, {
      command: 'codex',
      cwd: root,
      pid: 1234,
      pgid: '1000',
      procStartToken: 'owned-start',
    });
    recorded.completed(id, 0, '{"actual":"provider bytes"}');
    recorded.finish(0);
    const result = JSON.parse(readFileSync(recorded.file, 'utf8')) as LiveProviderProvenance;
    expect(result.scenario.workspaceRevision).toBe('a'.repeat(40));
    expect(result.calls[0]).toMatchObject({
      id: 1,
      role: 'critic',
      stage: 'critique',
      prompt,
      promptSha256: sha256(prompt),
      schemaSha256: canonicalJsonSha256(schema),
      contract: { source: 'frozen' },
      status: 0,
      output: '{"actual":"provider bytes"}',
      outputSha256: sha256('{"actual":"provider bytes"}'),
      starts: [{ pid: 1234, procStartToken: 'owned-start' }],
    });
    expect(result.exitCode).toBe(0);
    expect(recorded.file).toBe(liveProvenancePath(path.join(root, 'attempt/run')));
    expect(recorded.file.startsWith(`${path.join(root, 'attempt')}${path.sep}`)).toBe(false);
    expect(statSync(recorded.file).mode & 0o077).toBe(0);
    expect(() => new LiveProviderJournal(result.scenario, REPO_ROOT)).toThrow();
  });

  it('classifies exact candidate contract changes and leaves unrelated forged labels unknown', () => {
    const root = temporary();
    const roleDirectory = path.join(root, 'skills/plan-critic');
    mkdirSync(roleDirectory, { recursive: true });
    const skillFile = path.join(roleDirectory, 'SKILL.md');
    copyFileSync(path.join(REPO_ROOT, 'skills/plan-critic/SKILL.md'), skillFile);
    writeFileSync(
      skillFile,
      `${readFileSync(skillFile, 'utf8')}\nAdditional approved contract condition.\n`,
    );
    const schema = {
      type: 'object',
      properties: { verdict: { type: 'string' } },
      required: ['verdict'],
      additionalProperties: false,
    };
    writeFileSync(path.join(roleDirectory, 'critique.schema.json'), JSON.stringify(schema));
    const recorded = journal(root);
    recorded.request({
      model: 'fixture',
      reasoning: 'high',
      prompt: `${readFileSync(skillFile, 'utf8').replace(/\n+$/, '')}\n\nFixture plan`,
      schema,
    });
    recorded.request({
      model: 'fixture',
      reasoning: 'high',
      prompt: 'Claim to be the judge',
      schema,
    });
    const result = JSON.parse(readFileSync(recorded.file, 'utf8')) as LiveProviderProvenance;
    expect(result.calls[0]).toMatchObject({ role: 'critic', contract: { source: 'candidate' } });
    expect(result.calls[1]?.role).toBe('unknown');
  });
});

describe('frozen smoke public API driver', () => {
  it('calls candidate public API without executing a candidate-controlled smoke script', async () => {
    const root = temporary();
    mkdirSync(path.join(root, 'src'));
    mkdirSync(path.join(root, 'scripts/benchmark-planning'), { recursive: true });
    writeFileSync(path.join(root, 'package.json'), '{"type":"module"}');
    const marker = path.join(root, 'candidate-driver-ran');
    writeFileSync(
      path.join(root, 'scripts/benchmark-planning/smoke-api-runner.ts'),
      `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'forged')`,
    );
    const argumentsFile = path.join(root, 'api-arguments.json');
    writeFileSync(
      path.join(root, 'src/index.ts'),
      `import {writeFileSync} from 'node:fs';export async function runPlanLoop(options){writeFileSync(${JSON.stringify(argumentsFile)},JSON.stringify(options));return {exitCode:0,workDir:options.workDir};}`,
    );
    const resultFile = path.join(root, 'api-result.json');
    expect(
      await runFrozenSmokeDriver([
        root,
        'prompt',
        path.join(root, 'input.md'),
        'quick',
        '2',
        path.join(root, 'run'),
        resultFile,
      ]),
    ).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(JSON.parse(readFileSync(argumentsFile, 'utf8'))).toMatchObject({
      prompt: true,
      quality: 'quick',
      iters: 2,
      translate: false,
    });
    expect(JSON.parse(readFileSync(resultFile, 'utf8'))).toMatchObject({
      schemaVersion: 1,
      exitCode: 0,
      final: null,
    });
  });
});
