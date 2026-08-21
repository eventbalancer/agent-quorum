import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildSystemContext,
  validateSystemCoverage,
  writeSystemCheck,
} from '../../src/core/system-context.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('authoritative system context', () => {
  it('extracts cross-repository package edges and validates deterministically', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-system.'));
    roots.push(root);
    mkdirSync(path.join(root, 'producer'));
    mkdirSync(path.join(root, 'consumer'));
    writeFileSync(
      path.join(root, 'ecosystem.yaml'),
      [
        'regions: [eu-west-1]',
        'migration_commands: [pnpm root:migrate]',
        'migration_executors: [root-deploy-bot]',
        'delivery_stages: [prepare-release]',
        'authorization_boundaries: [root-production-approver]',
        'production_gates: [root-production-healthy]',
        'repositories:',
        '  producer:',
        '    path: producer',
        '  consumer:',
        '    path: consumer',
        '    depends_on: [producer]',
        '    migration_commands: [pnpm migrate:prod]',
        '    migration_executors: [deploy-bot]',
        '    authorization_boundaries: [production-approver]',
        '    delivery_gates: [production-healthy]',
        '    delivery_stages: [publish, deploy]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'producer', 'package.json'),
      JSON.stringify({
        name: '@fixture/producer',
        exports: { '.': './index.js' },
        scripts: { build: 'tsc' },
      }),
    );
    writeFileSync(
      path.join(root, 'consumer', 'package.json'),
      JSON.stringify({ name: '@fixture/consumer', dependencies: { '@fixture/producer': '1.0.0' } }),
    );
    writeFileSync(
      path.join(root, 'consumer', 'compose.yaml'),
      'services:\n  consumer:\n    image: consumer-image\n    depends_on: [producer-image]\n',
    );
    mkdirSync(path.join(root, 'consumer', '.github', 'workflows'), { recursive: true });
    writeFileSync(
      path.join(root, 'consumer', '.github', 'workflows', 'release.yaml'),
      'on: [push]\njobs:\n  build:\n    runs-on: ubuntu-latest\n  deploy:\n    needs: [build]\n    runs-on: ubuntu-latest\n',
    );
    const input = path.join(root, 'input.md');
    writeFileSync(input, '# Cross-repository scope\n\nCoordinate producer and consumer.');
    const context = buildSystemContext({ projectRoot: root, mode: 'prompt', inputFile: input });
    expect(context.crossRepository).toBe(true);
    expect(context.declaredScope).toEqual(['producer', 'consumer']);
    expect(context.facts.packages).toEqual(['@fixture/consumer', '@fixture/producer']);
    expect(context.facts.packageExports).toContain('@fixture/producer:.:"./index.js"');
    expect(context.facts.packageScripts).toContain('@fixture/producer:build:tsc');
    expect(context.facts.images).toContain('consumer-image');
    expect(context.facts.ciTriggers).toContain('release.yaml:push');
    expect(context.facts.authorizationBoundaries).toContain('production-approver');
    expect(context.facts.gates).toContain('production-healthy');
    expect(new Set(context.relationships.map((edge) => edge.type))).toEqual(
      new Set([
        'repository-dependency',
        'package-manifest',
        'package-consumer',
        'package-export',
        'package-script',
        'image-dependency',
        'image-publication',
        'ci-trigger',
        'workflow-trigger',
        'migration-executor',
        'authorization-boundary',
        'delivery-stage',
        'delivery-gate',
        'deployment-region',
      ]),
    );

    const plan = path.join(root, 'plan.md');
    const rows = context.relationships.map(
      (edge) =>
        `| ${edge.id} | ${edge.type} | ${edge.producer} | ${edge.consumer} | P1 | P2 | ${edge.tokens.join(' ')} |`,
    );
    writeFileSync(
      plan,
      [
        '# Plan',
        '## Work Plan',
        'P1 workspace prepare-release root-production-approver root-production-healthy producer @fixture/producer producer-image build migration pnpm root:migrate root-deploy-bot pnpm migrate:prod deploy-bot, then consumer @fixture/consumer consumer-image push release.yaml publish deploy production-approver production-healthy eu-west-1.',
        'P2 release gate after deploy.',
        '## System Coverage',
        '| Relationship ID | Type | Producer/authority | Consumer/executor | Implementation phase | Release stage/gate | Evidence |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n'),
    );
    const complete = readFileSync(plan, 'utf8');
    const first = validateSystemCoverage(context, plan, 0);
    const second = validateSystemCoverage(context, plan, 0);
    expect(second).toEqual(first);
    expect(first.passed).toBe(true);
    expect(first.planSha256).toBe(createHash('sha256').update(readFileSync(plan)).digest('hex'));
    expect(validateSystemCoverage(context, plan, 0, { required: true })).toMatchObject({
      passed: true,
      mismatches: [],
      requiredEvidenceUnavailable: [],
    });

    const repositoryEdge = context.relationships.find(
      (edge) => edge.type === 'repository-dependency',
    );
    expect(repositoryEdge).toBeDefined();
    if (repositoryEdge !== undefined) {
      const exactRow = rows.find((row) => row.includes(repositoryEdge.id)) ?? '';
      writeFileSync(plan, complete.replace(exactRow, exactRow.replace('| P1 |', '| P10 |')));
      expect(validateSystemCoverage(context, plan, 0).mismatches).toContain(
        `${repositoryEdge.id}:implementation-phase`,
      );
      writeFileSync(
        plan,
        complete.replace(
          exactRow,
          exactRow.replace(`| ${repositoryEdge.producer} |`, `| ${repositoryEdge.producer}-old |`),
        ),
      );
      expect(validateSystemCoverage(context, plan, 0).mismatches).toContain(
        `${repositoryEdge.id}:producer`,
      );
    }

    for (const row of rows) {
      writeFileSync(
        plan,
        complete
          .split('\n')
          .filter((entry) => entry !== row)
          .join('\n'),
      );
      const missing = validateSystemCoverage(context, plan, 0, { required: true });
      expect(missing.passed).toBe(false);
      expect(missing.mismatches.some((entry) => entry.endsWith(':missing'))).toBe(true);
      expect(missing.requiredEvidenceUnavailable).toEqual([]);
    }
  });

  it('rejects reversed producer and migration release ordering deterministically (AC-5/AC-6)', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-system-order.'));
    roots.push(root);
    mkdirSync(path.join(root, 'producer'));
    mkdirSync(path.join(root, 'consumer'));
    writeFileSync(
      path.join(root, 'ecosystem.yaml'),
      [
        'migration_commands: [pnpm migrate]',
        'migration_executors: [migration-runner]',
        'repositories:',
        '  producer:',
        '    path: producer',
        '  consumer:',
        '    path: consumer',
        '    depends_on: [producer]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'producer', 'package.json'),
      JSON.stringify({ name: '@fixture/producer' }),
    );
    writeFileSync(
      path.join(root, 'consumer', 'package.json'),
      JSON.stringify({ name: '@fixture/consumer' }),
    );
    const input = path.join(root, 'input.md');
    writeFileSync(input, '# Cross-repository scope\n\nCoordinate producer and consumer.');
    const context = buildSystemContext({ projectRoot: root, mode: 'prompt', inputFile: input });
    const rows = context.relationships.map(
      (edge) =>
        `| ${edge.id} | ${edge.type} | ${edge.producer} | ${edge.consumer} | P1 | P2 | ${edge.tokens.join(' ')} |`,
    );
    const plan = path.join(root, 'plan.md');
    const render = (workPlan: string) =>
      [
        '# Plan',
        '## Work Plan',
        workPlan,
        'P2 production gate.',
        '## System Coverage',
        '| Relationship ID | Type | Producer/authority | Consumer/executor | Implementation phase | Release stage/gate | Evidence |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n');

    writeFileSync(
      plan,
      render('P1 producer consumer migration pnpm migrate migration-runner then deploy.'),
    );
    expect(validateSystemCoverage(context, plan, 0).passed).toBe(true);

    const repositoryEdge = context.relationships.find(
      (edge) => edge.type === 'repository-dependency',
    );
    const migrationEdge = context.relationships.find((edge) => edge.type === 'migration-executor');
    expect(repositoryEdge).toBeDefined();
    expect(migrationEdge).toBeDefined();

    writeFileSync(
      plan,
      render('P1 consumer producer migration pnpm migrate migration-runner then deploy.'),
    );
    expect(validateSystemCoverage(context, plan, 0).mismatches).toContain(
      `${repositoryEdge?.id}:ordering:producer-before-consumer`,
    );

    writeFileSync(
      plan,
      render('P1 deploy first, then producer consumer migration pnpm migrate migration-runner.'),
    );
    expect(validateSystemCoverage(context, plan, 0).mismatches).toContain(
      `${migrationEdge?.id}:ordering:migration-before-deployment`,
    );
  });

  it.each(['traversal', 'absolute', 'symlink'] as const)(
    'rejects a repository %s escape without indexing or exposing the external source',
    (escapeKind) => {
      const fixtureRoot = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-containment.'));
      roots.push(fixtureRoot);
      const projectRoot = path.join(fixtureRoot, 'project');
      const externalRoot = path.join(fixtureRoot, 'external-authority');
      mkdirSync(path.join(projectRoot, 'safe-repo'), { recursive: true });
      mkdirSync(path.join(externalRoot, '.github', 'workflows'), { recursive: true });
      writeFileSync(
        path.join(projectRoot, 'safe-repo', 'package.json'),
        JSON.stringify({ name: '@fixture/safe' }),
      );
      const externalBody = `EXTERNAL_BODY_SENTINEL_${escapeKind}`;
      writeFileSync(
        path.join(externalRoot, 'package.json'),
        JSON.stringify({ name: '@external/secret', scripts: { leak: externalBody } }),
      );
      writeFileSync(
        path.join(externalRoot, 'compose.yaml'),
        `services:\n  leaked:\n    image: ${externalBody}\n`,
      );
      writeFileSync(
        path.join(externalRoot, '.github', 'workflows', 'leak.yaml'),
        `on: [push]\nname: ${externalBody}\n`,
      );

      let declaredPath: string;
      if (escapeKind === 'traversal') {
        declaredPath = '../external-authority';
      } else if (escapeKind === 'absolute') {
        declaredPath = externalRoot;
      } else {
        declaredPath = 'escaped-repository';
        symlinkSync(externalRoot, path.join(projectRoot, declaredPath), 'dir');
      }
      writeFileSync(
        path.join(projectRoot, 'ecosystem.yaml'),
        [
          'repositories:',
          '  safe-repo:',
          '    path: safe-repo',
          '  unsafe-repo:',
          `    path: ${JSON.stringify(declaredPath)}`,
          '    depends_on: [safe-repo]',
          '',
        ].join('\n'),
      );
      const input = path.join(projectRoot, 'input.md');
      writeFileSync(input, '# Cross-repository scope\n\nCoordinate safe-repo and unsafe-repo.');

      const context = buildSystemContext({ projectRoot, mode: 'prompt', inputFile: input });

      expect(context.declaredScope).toEqual(['safe-repo', 'unsafe-repo']);
      expect(context.limitations).toContain('repository-path-outside-project:unsafe-repo');
      expect(context.sources.map((source) => path.relative(projectRoot, source.path))).toEqual([
        'input.md',
        'ecosystem.yaml',
        path.join('safe-repo', 'package.json'),
      ]);
      expect(context.facts.packages).toEqual(['@fixture/safe']);
      const serialized = JSON.stringify(context);
      expect(serialized).not.toContain(externalRoot);
      expect(serialized).not.toContain('@external/secret');
      expect(serialized).not.toContain(externalBody);

      writeFileSync(
        path.join(externalRoot, 'package.json'),
        JSON.stringify({ name: '@external/changed', scripts: { leak: `${externalBody}_CHANGED` } }),
      );
      const afterExternalChange = buildSystemContext({
        projectRoot,
        mode: 'prompt',
        inputFile: input,
      });
      expect(afterExternalChange.digest).toBe(context.digest);
      expect(afterExternalChange.sources).toEqual(context.sources);
      expect(JSON.stringify(afterExternalChange)).not.toContain('@external/changed');

      const singleInput = path.join(projectRoot, 'single-input.md');
      writeFileSync(singleInput, '# Scope\n\nChange unsafe-repo only.');
      const singleContext = buildSystemContext({
        projectRoot,
        mode: 'prompt',
        inputFile: singleInput,
      });
      const singlePlan = path.join(projectRoot, 'single-plan.md');
      writeFileSync(singlePlan, '# Plan\n\n## Work Plan\n\nP1 safe local work.\n');
      expect(singleContext.crossRepository).toBe(false);
      expect(validateSystemCoverage(singleContext, singlePlan, 0).mismatches).toContain(
        'authoritative-limitation:repository-path-outside-project:unsafe-repo',
      );
    },
  );

  it('keeps a single-repository request scoped inside a multi-repository ecosystem', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-system-scope.'));
    roots.push(root);
    mkdirSync(path.join(root, 'services', 'producer'), { recursive: true });
    mkdirSync(path.join(root, 'consumer'));
    writeFileSync(
      path.join(root, 'ecosystem.yaml'),
      [
        'repositories:',
        '  producer:',
        '    path: services/producer',
        '    aliases: [producer-api]',
        '  consumer:',
        '    path: consumer',
        '    depends_on: [producer]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'services', 'producer', 'package.json'),
      JSON.stringify({ name: '@fixture/producer' }),
    );
    writeFileSync(
      path.join(root, 'consumer', 'package.json'),
      JSON.stringify({ name: '@fixture/consumer' }),
    );
    const input = path.join(root, 'input.md');
    writeFileSync(input, '# Scope\n\nChange validation in producer-api only.');

    const context = buildSystemContext({ projectRoot: root, mode: 'prompt', inputFile: input });

    expect(context.declaredScope).toEqual(['producer']);
    expect(context.crossRepository).toBe(false);
    expect(context.facts.repositories).toEqual(['producer']);
    expect(context.facts.packages).toEqual(['@fixture/producer']);
    expect(context.relationships).toEqual([]);

    writeFileSync(
      path.join(root, 'consumer', 'package.json'),
      JSON.stringify({ name: '@fixture/consumer', version: '2.0.0' }),
    );
    const afterUnrelatedChange = buildSystemContext({
      projectRoot: root,
      mode: 'prompt',
      inputFile: input,
    });
    expect(afterUnrelatedChange.digest).toBe(context.digest);

    writeFileSync(
      path.join(root, 'services', 'producer', 'package.json'),
      JSON.stringify({ name: '@fixture/producer', version: '2.0.0' }),
    );
    const afterScopedChange = buildSystemContext({
      projectRoot: root,
      mode: 'prompt',
      inputFile: input,
    });
    expect(afterScopedChange.digest).not.toBe(context.digest);
  });

  it('does not promote excluded repositories or delivery domains into scope', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-system-excluded-scope.'));
    roots.push(root);
    mkdirSync(path.join(root, 'producer'));
    mkdirSync(path.join(root, 'consumer'));
    writeFileSync(
      path.join(root, 'ecosystem.yaml'),
      [
        'repositories:',
        '  producer:',
        '    path: producer',
        '  consumer:',
        '    path: consumer',
        '    depends_on: [producer]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'producer', 'package.json'),
      JSON.stringify({ name: '@fixture/producer' }),
    );
    writeFileSync(
      path.join(root, 'consumer', 'package.json'),
      JSON.stringify({ name: '@fixture/consumer' }),
    );
    const input = path.join(root, 'input.md');
    writeFileSync(
      input,
      [
        '# Local producer change',
        '',
        '## Scope',
        '',
        'In scope:',
        '',
        '- Update producer parsing.',
        '',
        'Out of scope:',
        '',
        '- Consumer changes.',
        '- Cross-repository delivery.',
        '',
        '## Verification',
        '',
        'Run producer tests.',
      ].join('\n'),
    );

    const context = buildSystemContext({ projectRoot: root, mode: 'plan', inputFile: input });

    expect(context.declaredScope).toEqual(['producer']);
    expect(context.crossRepository).toBe(false);
    expect(context.relationships).toEqual([]);
    expect(context.limitations).not.toContain('declared-cross-repository-scope-unresolved');
    expect(context.limitations).not.toContain(
      'declared-cross-repository-relationships-unavailable',
    );
  });

  it('treats unavailable topology as telemetry unless cross-repository delivery requires it', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-system-applicability.'));
    roots.push(root);
    const input = path.join(root, 'input.md');
    const plan = path.join(root, 'plan.md');
    writeFileSync(input, '# Cross-repository delivery\n\nCoordinate producer and consumer.');
    writeFileSync(plan, '# Plan\n\n## Work Plan\n\nP1 update the local implementation.\n');
    const context = buildSystemContext({ projectRoot: root, mode: 'prompt', inputFile: input });

    expect(context.crossRepository).toBe(true);
    expect(context.relationships).toEqual([]);

    const irrelevant = validateSystemCoverage(context, plan, 0, { required: false });
    expect(irrelevant).toMatchObject({
      required: false,
      passed: true,
      relationships: [],
      mismatches: [],
      requiredEvidenceUnavailable: [],
    });
    expect(irrelevant.limitations).toContain('authoritative-topology-unavailable');

    const applicable = validateSystemCoverage(context, plan, 0, { required: true });
    expect(applicable).toMatchObject({
      required: true,
      passed: false,
      relationships: [],
      mismatches: [],
    });
    expect(applicable.requiredEvidenceUnavailable).toEqual(
      expect.arrayContaining([
        'cross-repository-scope:relationships-unavailable',
        'authoritative-limitation:authoritative-topology-unavailable',
      ]),
    );

    const legacy = validateSystemCoverage(context, plan, 0);
    expect(legacy.requiredEvidenceUnavailable).toEqual([]);
    expect(legacy.mismatches).toContain('cross-repository-scope:relationships-unavailable');

    const artifact = writeSystemCheck(root, applicable);
    expect(JSON.parse(readFileSync(artifact, 'utf8'))).toMatchObject({
      required: true,
      passed: false,
      mismatches: [],
      requiredEvidenceUnavailable: applicable.requiredEvidenceUnavailable,
    });
  });

  it('checks only relationships and unavailable evidence inside the frozen repository boundary', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-system-boundary.'));
    roots.push(root);
    mkdirSync(path.join(root, 'producer'));
    mkdirSync(path.join(root, 'consumer'));
    writeFileSync(
      path.join(root, 'ecosystem.yaml'),
      [
        'repositories:',
        '  producer:',
        '    path: producer',
        '  consumer:',
        '    path: consumer',
        '    depends_on: [producer]',
        '  unrelated:',
        '    path: ../unrelated',
        '    delivery_gates: [unrelated-ready]',
        '',
      ].join('\n'),
    );
    writeFileSync(
      path.join(root, 'producer', 'package.json'),
      JSON.stringify({ name: '@fixture/producer' }),
    );
    writeFileSync(
      path.join(root, 'consumer', 'package.json'),
      JSON.stringify({ name: '@fixture/consumer' }),
    );
    const input = path.join(root, 'input.md');
    writeFileSync(
      input,
      '# Cross-repository delivery\n\nInspect producer, consumer, and unrelated repositories.',
    );
    const context = buildSystemContext({ projectRoot: root, mode: 'prompt', inputFile: input });
    const boundary = new Set(['producer', 'consumer']);
    const boundedRelationships = context.relationships.filter((edge) =>
      edge.repositories.every((repository) => boundary.has(repository)),
    );
    const excludedRelationships = context.relationships.filter(
      (edge) => !boundedRelationships.includes(edge),
    );
    expect(excludedRelationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'delivery-gate', repositories: ['unrelated'] }),
      ]),
    );
    expect(context.limitations).toContain('repository-path-outside-project:unrelated');

    const plan = path.join(root, 'plan.md');
    const rows = boundedRelationships.map(
      (edge) =>
        `| ${edge.id} | ${edge.type} | ${edge.producer} | ${edge.consumer} | P1 | P2 | ${edge.tokens.join(' ')} |`,
    );
    writeFileSync(
      plan,
      [
        '# Plan',
        '## Work Plan',
        'P1 producer @fixture/producer then consumer @fixture/consumer.',
        'P2 release gate.',
        '## System Coverage',
        '| Relationship ID | Type | Producer/authority | Consumer/executor | Implementation phase | Release stage/gate | Evidence |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        ...rows,
      ].join('\n'),
    );

    const bounded = validateSystemCoverage(context, plan, 1, {
      required: true,
      inScope: ['producer implementation', 'consumer delivery'],
      outOfScope: ['unrelated repository'],
    });
    expect(bounded).toMatchObject({
      passed: true,
      boundaryRepositories: ['consumer', 'producer'],
      mismatches: [],
      requiredEvidenceUnavailable: [],
    });
    expect(bounded.relationships.map((relationship) => relationship.id)).toEqual(
      boundedRelationships.map((relationship) => relationship.id),
    );

    const unbounded = validateSystemCoverage(context, plan, 1, { required: true });
    expect(unbounded.passed).toBe(false);
    expect(unbounded.mismatches).toEqual(
      expect.arrayContaining(excludedRelationships.map((edge) => `${edge.id}:missing`)),
    );
    expect(unbounded.requiredEvidenceUnavailable).toContain(
      'authoritative-limitation:repository-path-outside-project:unrelated',
    );

    const relevantEvidenceMissing = validateSystemCoverage(
      {
        ...context,
        limitations: [...context.limitations, 'migration-executor-unavailable:consumer'],
      },
      plan,
      1,
      {
        required: true,
        inScope: ['producer implementation', 'consumer delivery'],
        outOfScope: ['unrelated repository'],
      },
    );
    expect(relevantEvidenceMissing.mismatches).toEqual([]);
    expect(relevantEvidenceMissing.requiredEvidenceUnavailable).toEqual([
      'authoritative-limitation:migration-executor-unavailable:consumer',
    ]);
  });

  it('activates explicit multi-repository scope and includes only named repositories', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-system-multi.'));
    roots.push(root);
    for (const repository of ['producer', 'consumer', 'unrelated']) {
      mkdirSync(path.join(root, repository));
      writeFileSync(
        path.join(root, repository, 'package.json'),
        JSON.stringify({ name: `@fixture/${repository}` }),
      );
    }
    writeFileSync(
      path.join(root, 'ecosystem.yaml'),
      [
        'repositories:',
        '  producer:',
        '    path: producer',
        '  consumer:',
        '    path: consumer',
        '    depends_on: [producer]',
        '  unrelated:',
        '    path: unrelated',
        '    depends_on: [producer]',
        '',
      ].join('\n'),
    );
    const input = path.join(root, 'input.md');
    writeFileSync(
      input,
      '# Multi-repository delivery\n\nCoordinate producer and consumer repositories.',
    );

    const context = buildSystemContext({ projectRoot: root, mode: 'plan', inputFile: input });

    expect(context.declaredScope).toEqual(['producer', 'consumer']);
    expect(context.crossRepository).toBe(true);
    expect(context.facts.packages).toEqual(['@fixture/consumer', '@fixture/producer']);
    expect(context.relationships).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'repository-dependency',
          producer: 'producer',
          consumer: 'consumer',
        }),
      ]),
    );
  });

  it('requires grounded not-applicable evidence and distinguishes malformed targets', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-system-evidence.'));
    roots.push(root);
    mkdirSync(path.join(root, 'producer'));
    mkdirSync(path.join(root, 'consumer'));
    writeFileSync(
      path.join(root, 'ecosystem.yaml'),
      [
        'repositories:',
        '  producer:',
        '    path: producer',
        '  consumer:',
        '    path: consumer',
        '    depends_on: [producer]',
        '',
      ].join('\n'),
    );
    const input = path.join(root, 'input.md');
    writeFileSync(input, '# Cross-repository scope\n\nCoordinate producer and consumer.');
    const context = buildSystemContext({ projectRoot: root, mode: 'prompt', inputFile: input });
    const edge = context.relationships[0];
    expect(edge).toBeDefined();
    if (edge === undefined) {
      return;
    }
    const plan = path.join(root, 'plan.md');
    const renderPlan = (evidence: string) =>
      [
        '# Plan',
        '## Work Plan',
        'No implementation or release action applies to this authoritative edge.',
        '## System Coverage',
        '| Relationship ID | Type | Producer/authority | Consumer/executor | Implementation phase | Release stage/gate | Evidence |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        `| ${edge.id} | ${edge.type} | ${edge.producer} | ${edge.consumer} | not-applicable | not-applicable | ${evidence} |`,
      ].join('\n');

    writeFileSync(plan, renderPlan(`topology:${edge.id}`));
    const first = validateSystemCoverage(context, plan, 2);
    const second = validateSystemCoverage(context, plan, 2);
    expect(second).toEqual(first);
    expect(first.passed).toBe(true);
    expect(first.relationships).toEqual([
      expect.objectContaining({ id: edge.id, disposition: 'not-applicable' }),
    ]);

    writeFileSync(plan, renderPlan('ecosystem.yaml:6'));
    expect(validateSystemCoverage(context, plan, 2).passed).toBe(true);

    writeFileSync(plan, renderPlan('topology:R-not-a-valid-id'));
    expect(validateSystemCoverage(context, plan, 2).mismatches).toContain(
      `${edge.id}:not-applicable-evidence:malformed`,
    );

    writeFileSync(plan, renderPlan(`topology:R-${'f'.repeat(64)}`));
    expect(validateSystemCoverage(context, plan, 2).mismatches).toContain(
      `${edge.id}:not-applicable-evidence:nonexistent`,
    );

    writeFileSync(plan, renderPlan('ecosystem.yaml:not-a-line'));
    expect(validateSystemCoverage(context, plan, 2).mismatches).toContain(
      `${edge.id}:not-applicable-evidence:malformed`,
    );

    writeFileSync(plan, renderPlan('missing.yaml:1'));
    expect(validateSystemCoverage(context, plan, 2).mismatches).toContain(
      `${edge.id}:not-applicable-evidence:nonexistent`,
    );

    writeFileSync(
      plan,
      renderPlan('phase-gate:P1:P2 release gate').replace(
        'No implementation or release action applies to this authoritative edge.',
        'P1 implementation gate.\nP2 release gate.',
      ),
    );
    expect(validateSystemCoverage(context, plan, 2).mismatches).toContain(
      `${edge.id}:not-applicable-evidence:nonexistent`,
    );

    writeFileSync(plan, renderPlan('the edge probably does not apply'));
    expect(validateSystemCoverage(context, plan, 2).mismatches).toContain(
      `${edge.id}:not-applicable-evidence:unanchored`,
    );
  });
});
