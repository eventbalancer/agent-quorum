import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { admitFinalPlan } from '../core/plan-admission.js';
import { readRunRecords } from '../core/run-store.js';
import { contentDigest, DeliveryError } from './contract.js';
import {
  assertProviderProjection,
  PROVIDER_PROVENANCE_ARTIFACT,
} from './live-provenance-admission.js';
import { liveProvenancePath } from './live-provenance.js';

export interface PlanningArtifactBundle {
  readonly version: 1;
  readonly files: Readonly<Record<string, string>>;
}

export interface PlanningArtifactProjection {
  readonly files: Readonly<Record<string, string>>;
}

const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;
const ARTIFACT_NAME =
  /^(?:run\/[a-zA-Z0-9_.-]+\.(?:json|md)|state\/runs\/[a-zA-Z0-9_.-]+\.json|api-result\.json|provider-provenance\.json|input\.md)$/;

function textFile(file: string): string {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > MAX_BUNDLE_BYTES) {
    throw new DeliveryError('invalid-planning-artifact-file');
  }
  return readFileSync(file, 'utf8');
}

export function collectPlanningArtifacts(
  workDir: string,
  stateDir: string,
  inputFile: string,
): string {
  const files: Record<string, string> = { 'input.md': textFile(inputFile) };
  for (const name of readdirSync(workDir).sort()) {
    if (/^[a-zA-Z0-9_.-]+\.(?:json|md)$/.test(name)) {
      files[`run/${name}`] = textFile(path.join(workDir, name));
    }
  }
  const recordsDir = path.join(stateDir, 'runs');
  if (existsSync(recordsDir)) {
    for (const name of readdirSync(recordsDir).sort()) {
      if (/^[a-zA-Z0-9_.-]+\.json$/.test(name)) {
        files[`state/runs/${name}`] = textFile(path.join(recordsDir, name));
      }
    }
  }
  const api = path.join(path.dirname(workDir), 'api-result.json');
  if (existsSync(api)) {
    files['api-result.json'] = textFile(api);
  }
  const provenance = liveProvenancePath(workDir);
  if (existsSync(provenance)) {
    const metadata = lstatSync(provenance);
    if ((metadata.mode & 0o077) !== 0 || metadata.uid !== process.getuid?.()) {
      throw new DeliveryError('live-provider-provenance-not-private');
    }
    files[PROVIDER_PROVENANCE_ARTIFACT] = textFile(provenance);
  }
  const result = JSON.stringify({ version: 1, files });
  if (Buffer.byteLength(result) > MAX_BUNDLE_BYTES || Object.keys(files).length > 1024) {
    throw new DeliveryError('planning-artifact-bundle-limit');
  }
  return result;
}

export function planningArtifactsNeedDecoder(input: string): boolean {
  const bundle = parsePlanningArtifactBundle(input);
  const versions: readonly [RegExp, number][] = [
    [/^run\/convergence\.(?:final|v[0-9]+)\.json$/, 3],
    [/^run\/readiness-contract\.json$/, 2],
    [/^run\/judge\.final\.meta\.json$/, 2],
    [/^state\/runs\/.+\.json$/, 1],
    [/^api-result\.json$/, 1],
  ];
  return Object.entries(bundle.files).some(([name, text]) => {
    const expected = versions.find(([pattern]) => pattern.test(name))?.[1];
    if (expected === undefined) {
      return false;
    }
    try {
      const value: unknown = JSON.parse(text);
      return (
        typeof value === 'object' &&
        value !== null &&
        'schemaVersion' in value &&
        typeof value.schemaVersion === 'number' &&
        Number.isSafeInteger(value.schemaVersion) &&
        value.schemaVersion > expected
      );
    } catch {
      return false;
    }
  });
}

export function parsePlanningArtifactProjection(value: unknown): PlanningArtifactProjection {
  if (
    typeof value !== 'object' ||
    value === null ||
    Array.isArray(value) ||
    !('files' in value) ||
    Object.keys(value).length !== 1 ||
    typeof value.files !== 'object' ||
    value.files === null ||
    Array.isArray(value.files)
  ) {
    throw new DeliveryError('invalid-decoder-artifact-projection');
  }
  const entries = Object.entries(value.files);
  if (
    entries.length === 0 ||
    entries.length > 1024 ||
    entries.some(([name, text]) => !ARTIFACT_NAME.test(name) || typeof text !== 'string') ||
    Buffer.byteLength(JSON.stringify(value)) > MAX_BUNDLE_BYTES
  ) {
    throw new DeliveryError('invalid-decoder-artifact-projection');
  }
  return { files: Object.fromEntries(entries) };
}

export function parsePlanningArtifactBundle(input: string): PlanningArtifactBundle {
  const value: unknown = JSON.parse(input);
  if (
    typeof value !== 'object' ||
    value === null ||
    !('version' in value) ||
    value.version !== 1 ||
    !('files' in value) ||
    Object.keys(value).length !== 2
  ) {
    throw new DeliveryError('invalid-planning-artifact-bundle');
  }
  return { version: 1, files: parsePlanningArtifactProjection({ files: value.files }).files };
}

export function withPlanningArtifactProjection<T>(
  input: string,
  projection: PlanningArtifactProjection,
  scratchRoot: string,
  evaluate: (workDir: string, stateDir: string) => T,
): T {
  const source = parsePlanningArtifactBundle(input);
  assertProviderProjection(
    source.files[PROVIDER_PROVENANCE_ARTIFACT],
    projection.files[PROVIDER_PROVENANCE_ARTIFACT],
  );
  const markdown = Object.keys(source.files).filter((name) => name.endsWith('.md'));
  if (
    source.files['run/plan.final.md'] === undefined ||
    markdown.some((name) => source.files[name] !== projection.files[name]) ||
    Object.keys(projection.files).some(
      (name) => name.endsWith('.md') && source.files[name] !== projection.files[name],
    )
  ) {
    throw new DeliveryError('decoder-changed-original-plan-or-input');
  }
  mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(path.join(scratchRoot, 'projection-'));
  const workDir = path.join(root, 'run');
  const stateDir = path.join(root, 'state');
  const bindings: Readonly<Record<string, string>> = {
    '@WORK_DIR@': workDir,
    '@STATE_DIR@': stateDir,
    '@INPUT_PATH@': path.join(root, 'input.md'),
    '@PROOF_PATH@': path.join(workDir, 'convergence.final.json'),
  };
  try {
    for (const [name, text] of Object.entries(projection.files)) {
      const file = path.join(root, name);
      mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const rendered =
        name.endsWith('.json') && name !== PROVIDER_PROVENANCE_ARTIFACT
          ? Object.entries(bindings).reduce(
              (value, [token, resolved]) =>
                value.replaceAll(token, JSON.stringify(resolved).slice(1, -1)),
              text,
            )
          : text;
      writeFileSync(file, rendered, { mode: 0o400, flag: 'wx' });
    }
    const records = readRunRecords(stateDir);
    const record = records[0];
    if (
      records.length !== 1 ||
      record?.workDir !== workDir ||
      !admitFinalPlan({
        workDir,
        record,
        expectedSourceDigest: contentDigest(source.files['input.md'] ?? ''),
      }).admitted
    ) {
      throw new DeliveryError('decoder-projection-readiness-rejected');
    }
    return evaluate(workDir, stateDir);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
