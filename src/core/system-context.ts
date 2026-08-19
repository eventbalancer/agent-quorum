import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { parseDocument } from 'yaml';
import { stableTupleId } from './convergence.js';
import { isJsonObject, type JsonObject, type JsonValue } from './json.js';
import { planPhaseGateExists } from './metrics.js';
import type { RunMode } from '../types.js';

export type SystemRelationshipType =
  | 'repository-dependency'
  | 'package-manifest'
  | 'package-consumer'
  | 'package-export'
  | 'package-script'
  | 'image-dependency'
  | 'image-publication'
  | 'ci-trigger'
  | 'workflow-trigger'
  | 'migration-executor'
  | 'authorization-boundary'
  | 'delivery-stage'
  | 'delivery-gate'
  | 'deployment-region';

export type SystemRelationshipOrdering =
  | 'producer-before-consumer'
  | 'migration-before-deployment'
  | 'none';

export type SystemCheckDisposition = 'covered' | 'not-applicable' | 'missing' | 'duplicate';

export interface SystemSource {
  readonly path: string;
  readonly sha256: string;
}

export interface SystemRelationship {
  readonly id: string;
  readonly type: SystemRelationshipType;
  readonly producer: string;
  readonly consumer: string;
  readonly authorityPath: string;
  readonly tokens: readonly string[];
  readonly ordering: SystemRelationshipOrdering;
}

export interface SystemFacts {
  readonly repositories: readonly string[];
  readonly packages: readonly string[];
  readonly packageExports: readonly string[];
  readonly packageScripts: readonly string[];
  readonly images: readonly string[];
  readonly workflows: readonly string[];
  readonly ciTriggers: readonly string[];
  readonly regions: readonly string[];
  readonly migrationCommands: readonly string[];
  readonly deliveryStages: readonly string[];
  readonly authorizationBoundaries: readonly string[];
  readonly gates: readonly string[];
}

export interface SystemContext {
  readonly schemaVersion: 1;
  readonly scopeSource: 'prompt' | 'direct-plan';
  readonly originalRequestAvailable: boolean;
  readonly declaredScope: readonly string[];
  readonly sources: readonly SystemSource[];
  readonly digest: string;
  readonly crossRepository: boolean;
  readonly relationships: readonly SystemRelationship[];
  readonly limitations: readonly string[];
  readonly facts: SystemFacts;
}

export interface SystemCheckRelationship {
  readonly id: string;
  readonly disposition: SystemCheckDisposition;
  readonly implementationPhase?: string;
  readonly releaseStage?: string;
  readonly evidence?: string;
}

export interface SystemCheck {
  readonly schemaVersion: 1;
  readonly planVersion: number;
  readonly planSha256: string;
  readonly systemDigest: string;
  readonly passed: boolean;
  readonly crossRepository: boolean;
  readonly relationships: readonly SystemCheckRelationship[];
  readonly mismatches: readonly string[];
  readonly limitations: readonly string[];
}

interface RepositoryEntry {
  readonly name: string;
  readonly value: JsonObject;
}

interface PackageDependency {
  readonly owner: string;
  readonly name: string;
  readonly file: string;
}

interface SystemContextAccumulator {
  readonly sources: SystemSource[];
  readonly relationships: SystemRelationship[];
  readonly declaredScope: string[];
  readonly limitations: string[];
  readonly packages: string[];
  readonly packageExports: string[];
  readonly packageScripts: string[];
  readonly images: string[];
  readonly workflows: string[];
  readonly ciTriggers: string[];
  readonly regions: string[];
  readonly migrationCommands: string[];
  readonly deliveryStages: string[];
  readonly authorizationBoundaries: string[];
  readonly gates: string[];
  readonly packageOwners: Map<string, string>;
  readonly packageDependencies: PackageDependency[];
}

export interface BuildSystemContextInput {
  readonly projectRoot: string;
  readonly mode: RunMode;
  readonly inputFile: string;
}

function createSystemContextAccumulator(): SystemContextAccumulator {
  return {
    sources: [],
    relationships: [],
    declaredScope: [],
    limitations: [],
    packages: [],
    packageExports: [],
    packageScripts: [],
    images: [],
    workflows: [],
    ciTriggers: [],
    regions: [],
    migrationCommands: [],
    deliveryStages: [],
    authorizationBoundaries: [],
    gates: [],
    packageOwners: new Map(),
    packageDependencies: [],
  };
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function strings(value: JsonValue | undefined): string[] {
  if (typeof value === 'string') {
    return [value];
  }
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

function repositories(root: JsonObject): RepositoryEntry[] {
  const raw = root.repositories ?? root.repos;
  if (Array.isArray(raw)) {
    return raw.filter(isJsonObject).flatMap((value) => {
      const name = typeof value.name === 'string' ? value.name : value.id;
      return typeof name === 'string' ? [{ name, value }] : [];
    });
  }
  if (!isJsonObject(raw)) {
    return [];
  }
  return Object.entries(raw).map(([name, rawValue]) => ({
    name,
    value: isJsonObject(rawValue) ? rawValue : { path: rawValue },
  }));
}

function addSource(sources: SystemSource[], file: string): string | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  const raw = readFileSync(file, 'utf8');
  sources.push({ path: file, sha256: sha256(raw) });
  return raw;
}

function pathIsInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function pathIsContainedByProject(projectRoot: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(projectRoot);
  const resolvedCandidate = path.resolve(candidate);
  if (!pathIsInside(resolvedRoot, resolvedCandidate)) {
    return false;
  }
  if (!existsSync(resolvedCandidate)) {
    return true;
  }
  try {
    return pathIsInside(realpathSync(resolvedRoot), realpathSync(resolvedCandidate));
  } catch {
    return false;
  }
}

function addRepositoryContainmentLimitation(
  accumulator: SystemContextAccumulator,
  repositoryName: string,
): void {
  const limitation = `repository-path-outside-project:${repositoryName}`;
  if (!accumulator.limitations.includes(limitation)) {
    accumulator.limitations.push(limitation);
  }
}

function addRepositorySource(
  accumulator: SystemContextAccumulator,
  projectRoot: string,
  repositoryName: string,
  file: string,
): string | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  if (!pathIsContainedByProject(projectRoot, file)) {
    addRepositoryContainmentLimitation(accumulator, repositoryName);
    return undefined;
  }
  return addSource(accumulator.sources, file);
}

function repositoryPath(projectRoot: string, repository: RepositoryEntry): string {
  const declared =
    typeof repository.value.path === 'string' ? repository.value.path : repository.name;
  return path.isAbsolute(declared) ? declared : path.resolve(projectRoot, declared);
}

function yamlObject(raw: string): JsonObject {
  const value = parseDocument(raw, { prettyErrors: true }).toJS() as JsonValue;
  return isJsonObject(value) ? value : {};
}

function workflowFiles(root: string): string[] {
  const dir = path.join(root, '.github', 'workflows');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => /\.ya?ml$/.test(name))
    .sort()
    .map((name) => path.join(dir, name));
}

function composeFiles(root: string): string[] {
  return ['compose.yaml', 'compose.yml', 'docker-compose.yaml', 'docker-compose.yml']
    .map((name) => path.join(root, name))
    .filter(existsSync);
}

function relationship(
  type: SystemRelationship['type'],
  producer: string,
  consumer: string,
  authorityPath: string,
  tokens: readonly string[],
  ordering: SystemRelationship['ordering'],
): SystemRelationship {
  return {
    id: stableTupleId('R', [type, producer, consumer, [...tokens].sort()]),
    type,
    producer,
    consumer,
    authorityPath,
    tokens: [...tokens],
    ordering,
  };
}

function extractEcosystemRelationships(
  file: string,
  value: JsonObject,
  repositoryEntries: readonly RepositoryEntry[],
): SystemRelationship[] {
  const result: SystemRelationship[] = [];
  for (const repo of repositoryEntries) {
    for (const region of [...strings(value.regions), ...strings(repo.value.regions)]) {
      result.push(
        relationship('deployment-region', repo.name, region, file, [repo.name, region], 'none'),
      );
    }
    for (const dependency of strings(repo.value.depends_on)) {
      result.push(
        relationship(
          'repository-dependency',
          dependency,
          repo.name,
          file,
          [dependency, repo.name],
          'producer-before-consumer',
        ),
      );
    }
    const npm = isJsonObject(repo.value.npm) ? repo.value.npm : {};
    const packageName = typeof npm.package === 'string' ? npm.package : undefined;
    for (const consumer of strings(npm.consumers)) {
      result.push(
        relationship(
          'package-consumer',
          packageName ?? repo.name,
          consumer,
          file,
          [packageName ?? repo.name, consumer],
          'producer-before-consumer',
        ),
      );
    }
    const image = typeof repo.value.image === 'string' ? repo.value.image : undefined;
    for (const consumer of strings(repo.value.image_consumers)) {
      result.push(
        relationship(
          'image-dependency',
          image ?? repo.name,
          consumer,
          file,
          [image ?? repo.name, consumer],
          'producer-before-consumer',
        ),
      );
    }
    for (const workflow of strings(repo.value.ci_triggers)) {
      result.push(
        relationship('ci-trigger', repo.name, workflow, file, [repo.name, workflow], 'none'),
      );
    }
    const migrationCommands = strings(repo.value.migration_commands);
    const migrationExecutors = strings(repo.value.migration_executors);
    for (const executor of migrationExecutors) {
      result.push(
        relationship(
          'migration-executor',
          repo.name,
          executor,
          file,
          [repo.name, executor, ...migrationCommands],
          'migration-before-deployment',
        ),
      );
    }
    for (const boundary of strings(repo.value.authorization_boundaries)) {
      result.push(
        relationship(
          'authorization-boundary',
          repo.name,
          boundary,
          file,
          [repo.name, boundary],
          'none',
        ),
      );
    }
    for (const gate of [
      ...strings(repo.value.delivery_gates),
      ...strings(repo.value.production_gates),
    ]) {
      result.push(relationship('delivery-gate', repo.name, gate, file, [repo.name, gate], 'none'));
    }
    const stages = strings(repo.value.delivery_stages);
    for (const [index, stage] of stages.entries()) {
      const producer = index === 0 ? repo.name : (stages[index - 1] ?? repo.name);
      result.push(
        relationship(
          'delivery-stage',
          producer,
          stage,
          file,
          [producer, stage],
          index === 0 ? 'none' : 'producer-before-consumer',
        ),
      );
    }
  }
  return result;
}

function extractRootRelationships(file: string, value: JsonObject): SystemRelationship[] {
  const result: SystemRelationship[] = [];
  const stages = strings(value.delivery_stages);
  for (const [index, stage] of stages.entries()) {
    const producer = index === 0 ? 'workspace' : (stages[index - 1] ?? 'workspace');
    result.push(
      relationship(
        'delivery-stage',
        producer,
        stage,
        file,
        [producer, stage],
        index === 0 ? 'none' : 'producer-before-consumer',
      ),
    );
  }
  for (const boundary of strings(value.authorization_boundaries)) {
    result.push(
      relationship(
        'authorization-boundary',
        'workspace',
        boundary,
        file,
        ['workspace', boundary],
        'none',
      ),
    );
  }
  for (const gate of [...strings(value.delivery_gates), ...strings(value.production_gates)]) {
    result.push(
      relationship('delivery-gate', 'workspace', gate, file, ['workspace', gate], 'none'),
    );
  }
  const commands = strings(value.migration_commands);
  const executors = strings(value.migration_executors);
  for (const executor of executors) {
    result.push(
      relationship(
        'migration-executor',
        commands.join(', ') || 'workspace-migration',
        executor,
        file,
        [...commands, executor],
        'migration-before-deployment',
      ),
    );
  }
  return result;
}

function collectPackageManifest(
  accumulator: SystemContextAccumulator,
  projectRoot: string,
  repositoryName: string,
  packageFile: string,
): void {
  const packageRaw = addRepositorySource(accumulator, projectRoot, repositoryName, packageFile);
  if (packageRaw === undefined) {
    return;
  }
  try {
    const manifest = JSON.parse(packageRaw) as JsonValue;
    if (!isJsonObject(manifest) || typeof manifest.name !== 'string') {
      return;
    }
    accumulator.packages.push(manifest.name);
    accumulator.packageOwners.set(manifest.name, repositoryName);
    accumulator.relationships.push(
      relationship(
        'package-manifest',
        repositoryName,
        manifest.name,
        packageFile,
        [repositoryName, manifest.name],
        'none',
      ),
    );
    const exportsValue = manifest.exports;
    if (typeof exportsValue === 'string') {
      accumulator.packageExports.push(`${manifest.name}:.:${exportsValue}`);
      accumulator.relationships.push(
        relationship(
          'package-export',
          manifest.name,
          '.',
          packageFile,
          [manifest.name, '.', exportsValue],
          'none',
        ),
      );
    } else if (isJsonObject(exportsValue)) {
      for (const [exportName, target] of Object.entries(exportsValue)) {
        const serializedTarget = JSON.stringify(target);
        accumulator.packageExports.push(`${manifest.name}:${exportName}:${serializedTarget}`);
        accumulator.relationships.push(
          relationship(
            'package-export',
            manifest.name,
            exportName,
            packageFile,
            [manifest.name, exportName, serializedTarget],
            'none',
          ),
        );
      }
    }
    const scripts = isJsonObject(manifest.scripts) ? manifest.scripts : {};
    for (const [scriptName, command] of Object.entries(scripts)) {
      if (typeof command === 'string') {
        accumulator.packageScripts.push(`${manifest.name}:${scriptName}:${command}`);
        accumulator.relationships.push(
          relationship(
            'package-script',
            manifest.name,
            scriptName,
            packageFile,
            [manifest.name, scriptName, command],
            'none',
          ),
        );
      }
    }
    for (const key of ['dependencies', 'peerDependencies', 'optionalDependencies']) {
      const dependencies = isJsonObject(manifest[key]) ? manifest[key] : {};
      for (const dependency of Object.keys(dependencies)) {
        accumulator.packageDependencies.push({
          owner: repositoryName,
          name: dependency,
          file: packageFile,
        });
      }
    }
  } catch {
    accumulator.limitations.push(`malformed-authoritative-json:${packageFile}`);
  }
}

function collectComposeFiles(
  accumulator: SystemContextAccumulator,
  projectRoot: string,
  repositoryName: string,
  rootDir: string,
): void {
  for (const composeFile of composeFiles(rootDir)) {
    const composeRaw = addRepositorySource(accumulator, projectRoot, repositoryName, composeFile);
    if (composeRaw === undefined) {
      continue;
    }
    try {
      const compose = yamlObject(composeRaw);
      const services = isJsonObject(compose.services) ? compose.services : {};
      for (const [serviceName, rawService] of Object.entries(services)) {
        const service = isJsonObject(rawService) ? rawService : {};
        const image = typeof service.image === 'string' ? service.image : serviceName;
        accumulator.images.push(image);
        accumulator.relationships.push(
          relationship(
            'image-publication',
            serviceName,
            image,
            composeFile,
            [serviceName, image],
            'none',
          ),
        );
        for (const dependency of strings(service.depends_on)) {
          accumulator.relationships.push(
            relationship(
              'image-dependency',
              dependency,
              image,
              composeFile,
              [dependency, image],
              'producer-before-consumer',
            ),
          );
        }
        if (isJsonObject(service.depends_on)) {
          for (const dependency of Object.keys(service.depends_on)) {
            accumulator.relationships.push(
              relationship(
                'image-dependency',
                dependency,
                image,
                composeFile,
                [dependency, image],
                'producer-before-consumer',
              ),
            );
          }
        }
      }
    } catch {
      accumulator.limitations.push(`malformed-authoritative-yaml:${composeFile}`);
    }
  }
}

function collectWorkflowFiles(
  accumulator: SystemContextAccumulator,
  projectRoot: string,
  repositoryName: string,
  rootDir: string,
): void {
  const workflowDir = path.join(rootDir, '.github', 'workflows');
  if (existsSync(workflowDir) && !pathIsContainedByProject(projectRoot, workflowDir)) {
    addRepositoryContainmentLimitation(accumulator, repositoryName);
    return;
  }
  for (const workflowFile of workflowFiles(rootDir)) {
    const workflowRaw = addRepositorySource(accumulator, projectRoot, repositoryName, workflowFile);
    if (workflowRaw === undefined) {
      continue;
    }
    accumulator.workflows.push(path.basename(workflowFile));
    try {
      const workflow = yamlObject(workflowRaw);
      const triggers = workflow.on;
      if (isJsonObject(triggers)) {
        for (const trigger of Object.keys(triggers)) {
          accumulator.ciTriggers.push(`${path.basename(workflowFile)}:${trigger}`);
          accumulator.relationships.push(
            relationship(
              'workflow-trigger',
              trigger,
              path.basename(workflowFile),
              workflowFile,
              [trigger, path.basename(workflowFile)],
              'none',
            ),
          );
        }
      } else {
        for (const trigger of strings(triggers)) {
          accumulator.ciTriggers.push(`${path.basename(workflowFile)}:${trigger}`);
          accumulator.relationships.push(
            relationship(
              'workflow-trigger',
              trigger,
              path.basename(workflowFile),
              workflowFile,
              [trigger, path.basename(workflowFile)],
              'none',
            ),
          );
        }
      }
      const jobs = isJsonObject(workflow.jobs) ? workflow.jobs : {};
      for (const [jobName, rawJob] of Object.entries(jobs)) {
        const job = isJsonObject(rawJob) ? rawJob : {};
        for (const dependency of strings(job.needs)) {
          accumulator.relationships.push(
            relationship(
              'ci-trigger',
              dependency,
              jobName,
              workflowFile,
              [dependency, jobName],
              'producer-before-consumer',
            ),
          );
        }
        if (typeof job.needs === 'string') {
          accumulator.relationships.push(
            relationship(
              'ci-trigger',
              job.needs,
              jobName,
              workflowFile,
              [job.needs, jobName],
              'producer-before-consumer',
            ),
          );
        }
        if (typeof job.uses === 'string') {
          accumulator.relationships.push(
            relationship(
              'ci-trigger',
              job.uses,
              jobName,
              workflowFile,
              [job.uses, jobName],
              'producer-before-consumer',
            ),
          );
        }
      }
    } catch {
      accumulator.limitations.push(`malformed-authoritative-yaml:${workflowFile}`);
    }
  }
}

function collectRepositorySources(
  accumulator: SystemContextAccumulator,
  projectRoot: string,
  repository: RepositoryEntry,
): void {
  accumulator.regions.push(...strings(repository.value.regions));
  const repositoryMigrationCommands = strings(repository.value.migration_commands);
  accumulator.migrationCommands.push(...repositoryMigrationCommands);
  if (
    repositoryMigrationCommands.length > 0 &&
    strings(repository.value.migration_executors).length === 0
  ) {
    accumulator.limitations.push(`migration-executor-unavailable:${repository.name}`);
  }
  accumulator.deliveryStages.push(...strings(repository.value.delivery_stages));
  accumulator.authorizationBoundaries.push(...strings(repository.value.authorization_boundaries));
  accumulator.gates.push(
    ...strings(repository.value.delivery_gates),
    ...strings(repository.value.production_gates),
  );
  const rootDir = repositoryPath(projectRoot, repository);
  if (!pathIsContainedByProject(projectRoot, rootDir)) {
    addRepositoryContainmentLimitation(accumulator, repository.name);
    return;
  }
  collectPackageManifest(
    accumulator,
    projectRoot,
    repository.name,
    path.join(rootDir, 'package.json'),
  );
  collectComposeFiles(accumulator, projectRoot, repository.name, rootDir);
  collectWorkflowFiles(accumulator, projectRoot, repository.name, rootDir);
}

function repositoryAliases(projectRoot: string, repository: RepositoryEntry): string[] {
  const declaredPath =
    typeof repository.value.path === 'string' ? repository.value.path : repository.name;
  const resolvedPath = repositoryPath(projectRoot, repository);
  return [
    repository.name,
    declaredPath,
    path.normalize(declaredPath),
    path.basename(declaredPath),
    ...(pathIsContainedByProject(projectRoot, resolvedPath) ? [resolvedPath] : []),
    ...strings(repository.value.alias),
    ...strings(repository.value.aliases),
  ].filter(
    (value, index, values) => value !== '' && value !== '.' && values.indexOf(value) === index,
  );
}

function sourceMentionsRepository(source: string, aliases: readonly string[]): boolean {
  return aliases.some((alias) => {
    const escaped = alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?:^|[^A-Za-z0-9_@/-])${escaped}(?=$|[^A-Za-z0-9_@/-])`, 'i').test(source);
  });
}

function declaredRepositories(
  projectRoot: string,
  source: string,
  entries: readonly RepositoryEntry[],
): RepositoryEntry[] {
  const named = entries.filter((entry) =>
    sourceMentionsRepository(source, repositoryAliases(projectRoot, entry)),
  );
  if (named.length > 0) {
    return named;
  }
  return entries.filter((entry) => repositoryPath(projectRoot, entry) === projectRoot);
}

function explicitlyRequestsCrossRepositoryScope(source: string): boolean {
  return (
    /\b(?:cross|multi)[- ]repositor(?:y|ies)\b/i.test(source) ||
    /\bmultiple\s+repositor(?:y|ies)\b/i.test(source) ||
    /\bacross\s+(?:the\s+)?repositor(?:y|ies)\b/i.test(source) ||
    /<repositories\b/i.test(source)
  );
}

export function buildSystemContext(input: BuildSystemContextInput): SystemContext {
  const accumulator = createSystemContextAccumulator();
  const {
    sources,
    relationships,
    declaredScope,
    limitations,
    packages,
    packageExports,
    packageScripts,
    images,
    workflows,
    ciTriggers,
    regions,
    migrationCommands,
    deliveryStages,
    authorizationBoundaries,
    gates,
    packageOwners,
    packageDependencies,
  } = accumulator;
  const sourceFile = path.resolve(input.inputFile);
  let sourceRaw = '';
  if (existsSync(sourceFile)) {
    sourceRaw = readFileSync(sourceFile, 'utf8');
    sources.push({ path: sourceFile, sha256: sha256(sourceRaw) });
  }
  const explicitlyCrossRepository = explicitlyRequestsCrossRepositoryScope(sourceRaw);
  const ecosystem = path.join(input.projectRoot, 'ecosystem.yaml');
  if (existsSync(ecosystem)) {
    const raw = addSource(sources, ecosystem) ?? '';
    try {
      const root = yamlObject(raw);
      const repoEntries = repositories(root);
      const scopedRepositories = declaredRepositories(input.projectRoot, sourceRaw, repoEntries);
      declaredScope.push(...scopedRepositories.map((repo) => repo.name));
      regions.push(...strings(root.regions));
      migrationCommands.push(...strings(root.migration_commands));
      deliveryStages.push(...strings(root.delivery_stages));
      authorizationBoundaries.push(...strings(root.authorization_boundaries));
      gates.push(...strings(root.delivery_gates), ...strings(root.production_gates));
      relationships.push(...extractEcosystemRelationships(ecosystem, root, scopedRepositories));
      relationships.push(...extractRootRelationships(ecosystem, root));
      if (
        strings(root.migration_commands).length > 0 &&
        strings(root.migration_executors).length === 0
      ) {
        limitations.push('migration-executor-unavailable:workspace');
      }
      for (const repo of scopedRepositories) {
        collectRepositorySources(accumulator, input.projectRoot, repo);
      }
      for (const dependency of packageDependencies) {
        const producer = packageOwners.get(dependency.name);
        if (producer !== undefined) {
          relationships.push(
            relationship(
              'package-consumer',
              dependency.name,
              dependency.owner,
              dependency.file,
              [dependency.name, dependency.owner],
              'producer-before-consumer',
            ),
          );
        }
      }
    } catch {
      limitations.push(`malformed-authoritative-yaml:${ecosystem}`);
    }
  }
  if (!existsSync(ecosystem)) {
    limitations.push('authoritative-topology-unavailable');
  }
  const crossRepository = declaredScope.length > 1 || explicitlyCrossRepository;
  const crossRepositoryOnlyTypes = new Set<SystemRelationshipType>([
    'package-manifest',
    'package-export',
    'package-script',
    'image-publication',
    'workflow-trigger',
  ]);
  const uniqueSources = [...new Map(sources.map((source) => [source.path, source])).values()];
  const uniqueRelationships = [
    ...new Map(
      relationships
        .filter((edge) => crossRepository || !crossRepositoryOnlyTypes.has(edge.type))
        .map((edge) => [edge.id, edge]),
    ).values(),
  ];
  const canonicalSources = uniqueSources.map((source) => [
    path.relative(input.projectRoot, source.path),
    source.sha256,
  ]);
  const canonicalRelationships = uniqueRelationships.map((edge) => ({
    ...edge,
    authorityPath: path.relative(input.projectRoot, edge.authorityPath),
  }));
  if (explicitlyCrossRepository && declaredScope.length < 2) {
    limitations.push('declared-cross-repository-scope-unresolved');
  }
  if (explicitlyCrossRepository && uniqueRelationships.length === 0) {
    limitations.push('declared-cross-repository-relationships-unavailable');
  }
  return {
    schemaVersion: 1,
    scopeSource: input.mode === 'prompt' ? 'prompt' : 'direct-plan',
    originalRequestAvailable: input.mode === 'prompt',
    declaredScope,
    sources: uniqueSources,
    digest: sha256(
      JSON.stringify({ canonicalSources, relationships: canonicalRelationships, declaredScope }),
    ),
    crossRepository,
    relationships: uniqueRelationships,
    limitations,
    facts: {
      repositories: [...new Set(declaredScope)].sort(),
      packages: [...new Set(packages)].sort(),
      packageExports: [...new Set(packageExports)].sort(),
      packageScripts: [...new Set(packageScripts)].sort(),
      images: [...new Set(images)].sort(),
      workflows: [...new Set(workflows)].sort(),
      ciTriggers: [...new Set(ciTriggers)].sort(),
      regions: [...new Set(regions)].sort(),
      migrationCommands: [...new Set(migrationCommands)].sort(),
      deliveryStages: [...new Set(deliveryStages)].sort(),
      authorizationBoundaries: [...new Set(authorizationBoundaries)].sort(),
      gates: [...new Set(gates)].sort(),
    },
  };
}

export function writeSystemContext(work: string, context: SystemContext): string {
  const target = path.join(work, 'system-context.json');
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(context, null, 2)}\n`);
  renameSync(tmp, target);
  return target;
}

function systemCoverageRows(plan: string): Map<string, string[][]> {
  const heading = /^## System Coverage\s*$/m.exec(plan);
  if (heading === null) {
    return new Map();
  }
  const tail = plan.slice(heading.index + heading[0].length);
  const end = /^##\s+/m.exec(tail);
  const section = end === null ? tail : tail.slice(0, end.index);
  const rows = new Map<string, string[][]>();
  for (const line of section.split('\n')) {
    if (!line.trimStart().startsWith('|')) {
      continue;
    }
    const cells = line
      .split('|')
      .slice(1, -1)
      .map((cell) => cell.trim());
    const id = cells[0] ?? '';
    if (!/^R-[a-f0-9]{64}$/.test(id)) {
      continue;
    }
    rows.set(id, [...(rows.get(id) ?? []), cells]);
  }
  return rows;
}

function exactTokenIndex(text: string, token: string): number {
  const normalized = token.trim();
  if (normalized === '') {
    return -1;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `(?:^|[^A-Za-z0-9_@/.:-])(${escaped})(?=$|[^A-Za-z0-9_@/.:-])`,
    'i',
  ).exec(text);
  return match === null ? -1 : match.index + match[0].length - (match[1]?.length ?? 0);
}

function containsExactToken(text: string, token: string): boolean {
  return exactTokenIndex(text, token) >= 0;
}

function phaseExists(plan: string, reference: string): boolean {
  if (reference === '' || /^n\/?a$/i.test(reference)) {
    return false;
  }
  return containsExactToken(plan, reference);
}

function withoutMarkdownSection(plan: string, heading: string): string {
  const start = new RegExp(`^## ${heading}\\s*$`, 'm').exec(plan);
  if (start === null) {
    return plan;
  }
  const tailStart = start.index + start[0].length;
  const tail = plan.slice(tailStart);
  const end = /^##\s+/m.exec(tail);
  const endIndex = end === null ? plan.length : tailStart + end.index;
  return `${plan.slice(0, start.index)}${plan.slice(endIndex)}`;
}

function markdownSection(plan: string, heading: string): string {
  const start = new RegExp(`^## ${heading}\\s*$`, 'm').exec(plan);
  if (start === null) {
    return '';
  }
  const tail = plan.slice(start.index + start[0].length);
  const end = /^##\s+/m.exec(tail);
  return end === null ? tail : tail.slice(0, end.index);
}

function orderingMismatch(plan: string, edge: SystemRelationship): boolean {
  const workPlan = markdownSection(plan, 'Work Plan').toLowerCase();
  if (workPlan === '') {
    return true;
  }
  if (edge.ordering === 'producer-before-consumer') {
    const producer = exactTokenIndex(workPlan, edge.producer);
    const consumer = exactTokenIndex(workPlan, edge.consumer);
    return producer < 0 || consumer < 0 || producer > consumer;
  }
  if (edge.ordering === 'migration-before-deployment') {
    const executor = exactTokenIndex(workPlan, edge.consumer);
    const migration = workPlan.search(/\bmigrat(?:e|ion)\b/);
    if (executor < 0 || migration < 0) {
      return true;
    }
    const prerequisiteEnd = Math.max(executor + edge.consumer.length, migration + 7);
    const deploymentAfterPrerequisites = workPlan
      .slice(prerequisiteEnd)
      .search(/\bdeploy(?:ment)?\b|\brelease\b/);
    return deploymentAfterPrerequisites < 0;
  }
  return false;
}

type CoverageEvidenceStatus = 'grounded' | 'malformed' | 'nonexistent' | 'unanchored';

const COVERAGE_EVIDENCE_KINDS = [
  'file-line',
  'plan-section',
  'phase-gate',
  'command',
  'repository',
  'topology',
] as const;

type CoverageEvidenceKind = (typeof COVERAGE_EVIDENCE_KINDS)[number];

function coverageSource(context: SystemContext, reference: string): SystemSource | undefined {
  const normalized = path.normalize(reference);
  if (path.isAbsolute(normalized)) {
    return context.sources.find((source) => path.normalize(source.path) === normalized);
  }
  return context.sources.find((source) => {
    const sourcePath = path.normalize(source.path);
    return sourcePath === normalized || sourcePath.endsWith(`${path.sep}${normalized}`);
  });
}

function fileLineEvidenceStatus(context: SystemContext, reference: string): CoverageEvidenceStatus {
  const match = /^(.*\.[A-Za-z][\w-]*):(\d+)$/.exec(reference.trim());
  if (match === null || (match[1] ?? '').trim() === '' || Number(match[2]) < 1) {
    return 'malformed';
  }
  const source = coverageSource(context, match[1] ?? '');
  if (source === undefined || !existsSync(source.path)) {
    return 'nonexistent';
  }
  try {
    const raw = readFileSync(source.path, 'utf8');
    return raw.split('\n').length >= Number(match[2]) ? 'grounded' : 'nonexistent';
  } catch {
    return 'nonexistent';
  }
}

function planHeadingExists(plan: string, section: string): boolean {
  const normalized = section.replace(/^#{1,6}\s+/, '').trim();
  return (
    normalized !== '' &&
    plan
      .split('\n')
      .some(
        (line) => /^#{1,6}\s+/.test(line) && line.replace(/^#{1,6}\s+/, '').trim() === normalized,
      )
  );
}

function sourceContains(context: SystemContext, value: string): boolean {
  return context.sources.some((source) => {
    try {
      return existsSync(source.path) && readFileSync(source.path, 'utf8').includes(value);
    } catch {
      return false;
    }
  });
}

function typedCoverageEvidenceStatus(
  context: SystemContext,
  plan: string,
  planOutsideCoverage: string,
  kind: CoverageEvidenceKind,
  value: string,
): CoverageEvidenceStatus {
  const normalized = value.trim().replace(/^`|`$/g, '');
  if (normalized === '') {
    return 'malformed';
  }
  if (kind !== 'file-line' && /[\w./@-]+\.[A-Za-z][\w-]*:\d+/.test(normalized)) {
    return 'malformed';
  }
  if (kind !== 'topology' && /^R-[a-f0-9]{64}$/.test(normalized)) {
    return 'malformed';
  }
  switch (kind) {
    case 'file-line':
      return fileLineEvidenceStatus(context, normalized);
    case 'plan-section':
      return planHeadingExists(plan, normalized) ? 'grounded' : 'nonexistent';
    case 'phase-gate': {
      const parts = /^([^|:]+)[|:]\s*(.+)$/.exec(normalized);
      if (parts === null || (parts[1] ?? '').trim() === '' || (parts[2] ?? '').trim() === '') {
        return 'malformed';
      }
      return planPhaseGateExists(planOutsideCoverage, parts[1] ?? '', parts[2] ?? '')
        ? 'grounded'
        : 'nonexistent';
    }
    case 'command':
      return planOutsideCoverage.includes(normalized) || sourceContains(context, normalized)
        ? 'grounded'
        : 'nonexistent';
    case 'repository':
      return context.facts.repositories.includes(normalized) ||
        context.sources.some((source) =>
          path.normalize(source.path).split(path.sep).includes(normalized),
        )
        ? 'grounded'
        : 'nonexistent';
    case 'topology':
      if (!/^R-[a-f0-9]{64}$/.test(normalized)) {
        return 'malformed';
      }
      return context.relationships.some((edge) => edge.id === normalized)
        ? 'grounded'
        : 'nonexistent';
  }
}

function jsonCoverageEvidenceStatus(
  context: SystemContext,
  plan: string,
  planOutsideCoverage: string,
  evidence: string,
): CoverageEvidenceStatus | undefined {
  if (!evidence.startsWith('{')) {
    return undefined;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(evidence) as JsonValue;
  } catch {
    return 'malformed';
  }
  if (
    !isJsonObject(parsed) ||
    typeof parsed.kind !== 'string' ||
    !(COVERAGE_EVIDENCE_KINDS as readonly string[]).includes(parsed.kind)
  ) {
    return 'malformed';
  }
  const kind = parsed.kind as CoverageEvidenceKind;
  if (kind === 'phase-gate') {
    const valueParts =
      typeof parsed.value === 'string' ? /^([^|:]+)[|:]\s*(.+)$/.exec(parsed.value) : null;
    const phase = typeof parsed.phase === 'string' ? parsed.phase : valueParts?.[1];
    const gate = typeof parsed.gate === 'string' ? parsed.gate : valueParts?.[2];
    if (phase === undefined || phase.trim() === '' || gate === undefined || gate.trim() === '') {
      return 'malformed';
    }
    return planPhaseGateExists(planOutsideCoverage, phase, gate) ? 'grounded' : 'nonexistent';
  }
  const value =
    typeof parsed.value === 'string'
      ? parsed.value
      : kind === 'file-line' && typeof parsed.path === 'string' && typeof parsed.line === 'number'
        ? `${parsed.path}:${String(parsed.line)}`
        : kind === 'plan-section' && typeof parsed.section === 'string'
          ? parsed.section
          : kind === 'command' && typeof parsed.command === 'string'
            ? parsed.command
            : kind === 'repository' && typeof parsed.repository === 'string'
              ? parsed.repository
              : kind === 'topology' && typeof parsed.topology_id === 'string'
                ? parsed.topology_id
                : '';
  return typedCoverageEvidenceStatus(context, plan, planOutsideCoverage, kind, value);
}

function notApplicableEvidenceStatus(
  context: SystemContext,
  plan: string,
  planOutsideCoverage: string,
  evidence: string,
): CoverageEvidenceStatus {
  const normalized = evidence.trim();
  if (normalized === '') {
    return 'unanchored';
  }
  const jsonStatus = jsonCoverageEvidenceStatus(context, plan, planOutsideCoverage, normalized);
  if (jsonStatus !== undefined) {
    return jsonStatus;
  }
  const typed =
    /^(file-line|plan-section|phase-gate|command|repository|topology)\s*[:=]\s*(.*)$/i.exec(
      normalized.replace(/^`|`$/g, ''),
    );
  if (typed !== null) {
    return typedCoverageEvidenceStatus(
      context,
      plan,
      planOutsideCoverage,
      (typed[1] ?? '').toLowerCase() as CoverageEvidenceKind,
      typed[2] ?? '',
    );
  }
  const topologyReferences = normalized.match(/R-[A-Za-z0-9-]+/g) ?? [];
  if (topologyReferences.length > 0) {
    const statuses = topologyReferences.map((reference) =>
      typedCoverageEvidenceStatus(context, plan, planOutsideCoverage, 'topology', reference),
    );
    if (statuses.includes('grounded')) {
      return 'grounded';
    }
    return statuses.includes('nonexistent') ? 'nonexistent' : 'malformed';
  }
  const fileLineReferences = normalized.match(/[\w./@-]+\.[A-Za-z][\w-]*:\d+/g) ?? [];
  if (fileLineReferences.length > 0) {
    const statuses = fileLineReferences.map((reference) =>
      fileLineEvidenceStatus(context, reference),
    );
    return statuses.includes('grounded') ? 'grounded' : 'nonexistent';
  }
  const section = /#{1,6}\s+(.+)$/.exec(normalized);
  if (section !== null) {
    return planHeadingExists(plan, section[1] ?? '') ? 'grounded' : 'nonexistent';
  }
  if (/[\w./@-]+\.[A-Za-z][\w-]*:\S+/.test(normalized)) {
    return 'malformed';
  }
  return 'unanchored';
}

export function validateSystemCoverage(
  context: SystemContext,
  planFile: string,
  planVersion: number,
): SystemCheck {
  const plan = readFileSync(planFile, 'utf8');
  const rows = systemCoverageRows(plan);
  const planOutsideCoverage = withoutMarkdownSection(plan, 'System Coverage');
  const checks: SystemCheckRelationship[] = [];
  const mismatches: string[] = [];
  const applicableRelationships = context.crossRepository ? context.relationships : [];
  for (const edge of applicableRelationships) {
    const matches = rows.get(edge.id) ?? [];
    if (matches.length === 0) {
      checks.push({ id: edge.id, disposition: 'missing' });
      mismatches.push(`${edge.id}:missing`);
      continue;
    }
    if (matches.length > 1) {
      checks.push({ id: edge.id, disposition: 'duplicate' });
      mismatches.push(`${edge.id}:duplicate`);
      continue;
    }
    const row = matches[0] ?? [];
    const implementationPhase = row[4] ?? '';
    const releaseStage = row[5] ?? '';
    const evidence = row[6] ?? '';
    const notApplicable = /not[- ]applicable/i.test(row.join(' '));
    if ((row[1] ?? '') !== edge.type) {
      mismatches.push(`${edge.id}:type`);
    }
    if (!containsExactToken(row[2] ?? '', edge.producer)) {
      mismatches.push(`${edge.id}:producer`);
    }
    if (!containsExactToken(row[3] ?? '', edge.consumer)) {
      mismatches.push(`${edge.id}:consumer`);
    }
    if (notApplicable) {
      const evidenceStatus = notApplicableEvidenceStatus(
        context,
        plan,
        planOutsideCoverage,
        evidence,
      );
      if (evidenceStatus !== 'grounded') {
        mismatches.push(`${edge.id}:not-applicable-evidence:${evidenceStatus}`);
      }
    }
    if (!notApplicable && !phaseExists(planOutsideCoverage, implementationPhase)) {
      mismatches.push(`${edge.id}:implementation-phase`);
    }
    if (!notApplicable && !phaseExists(planOutsideCoverage, releaseStage)) {
      mismatches.push(`${edge.id}:release-stage`);
    }
    for (const token of edge.tokens) {
      if (!containsExactToken(row.join(' '), token)) {
        mismatches.push(`${edge.id}:token-${sha256(token)}`);
      }
    }
    if (!notApplicable && orderingMismatch(plan, edge)) {
      mismatches.push(`${edge.id}:ordering:${edge.ordering}`);
    }
    checks.push({
      id: edge.id,
      disposition: notApplicable ? 'not-applicable' : 'covered',
      implementationPhase,
      releaseStage,
      evidence,
    });
  }
  if (context.crossRepository && context.relationships.length === 0) {
    mismatches.push('cross-repository-scope:relationships-unavailable');
  }
  for (const limitation of context.limitations) {
    if (
      limitation.startsWith('malformed-authoritative-') ||
      limitation.startsWith('repository-path-outside-project:') ||
      context.crossRepository
    ) {
      mismatches.push(`authoritative-limitation:${limitation}`);
    }
  }
  return {
    schemaVersion: 1,
    planVersion,
    planSha256: sha256(plan),
    systemDigest: context.digest,
    passed: mismatches.length === 0,
    crossRepository: context.crossRepository,
    relationships: checks,
    mismatches: [...new Set(mismatches)].sort(),
    limitations: context.limitations,
  };
}

export function writeSystemCheck(work: string, check: SystemCheck, name?: string): string {
  const target = path.join(work, name ?? `system-check.v${check.planVersion}.json`);
  const tmp = `${target}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(check, null, 2)}\n`);
  renameSync(tmp, target);
  return target;
}
