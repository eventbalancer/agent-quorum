import { randomUUID } from 'node:crypto';
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  realpathSync,
  readdirSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { canonicalJsonSha256, fileSha256, sha256 } from '../core/digest.js';
import type { JsonObject } from '../core/json.js';
import { projectCodexJsonSchema } from '../providers/codex-schema.js';
import type { CodexProxyCall } from './codex-shim.js';
import type { ExecutionProcess } from '../runtime/execution-control.js';

export type LiveProviderRole =
  | 'creator'
  | 'critic'
  | 'judge'
  | 'reviewer'
  | 'fixer'
  | 'translator'
  | 'unknown';
export interface LiveProviderScenario {
  readonly id: string;
  readonly inputMode: string;
  readonly quality: string;
  readonly maxIterations: number;
  readonly inputSha256: string;
  readonly workDir: string;
  readonly repositoryRoot: string;
  readonly controllerDigest: string;
  readonly profileDigest: string;
  readonly providerConfigSha256: string;
  readonly workspaceRevision: string;
  readonly attemptIdentity: string;
}
export interface LiveProviderCall {
  readonly id: number;
  readonly role: LiveProviderRole;
  readonly stage?: string;
  readonly contract?: {
    readonly source: 'candidate' | 'frozen';
    readonly skillFile: string;
    readonly skillSha256: string;
    readonly schemaFile: string;
    readonly sourceSchemaSha256: string;
  };
  readonly prompt: string;
  readonly schema: unknown;
  readonly promptSha256: string;
  readonly schemaSha256: string;
  readonly model: string;
  readonly reasoning: string;
  readonly starts: readonly {
    readonly pid: number;
    readonly pgid: string;
    readonly procStartToken: string;
    readonly startedAt: string;
  }[];
  readonly status?: number;
  readonly output?: string;
  readonly outputSha256?: string;
}
export interface LiveProviderProvenance {
  readonly version: 1;
  readonly scenario: LiveProviderScenario;
  readonly calls: readonly LiveProviderCall[];
  readonly completedAt?: string;
  readonly exitCode?: number;
}
export function liveProvenancePath(workDir: string): string {
  return `${path.dirname(workDir)}.provider-provenance.json`;
}

const ROLE_DIRECTORIES: Readonly<Record<Exclude<LiveProviderRole, 'unknown'>, string>> = {
  creator: 'plan-creator',
  critic: 'plan-critic',
  judge: 'plan-judge',
  reviewer: 'plan-fix-reviewer',
  fixer: 'plan-fixer',
  translator: 'plan-translator',
};
function contractFile(root: string, relative: string): boolean {
  const absolute = path.join(root, relative);
  return (
    existsSync(absolute) &&
    lstatSync(absolute).isFile() &&
    realpathSync(absolute).startsWith(`${realpathSync(root)}${path.sep}`)
  );
}
function classification(
  request: CodexProxyCall,
  candidate: string,
  frozen: string,
): Pick<LiveProviderCall, 'role' | 'stage' | 'contract'> {
  for (const [source, root] of [
    ['candidate', candidate],
    ['frozen', frozen],
  ] as const) {
    for (const [role, directory] of Object.entries(ROLE_DIRECTORIES) as [
      Exclude<LiveProviderRole, 'unknown'>,
      string,
    ][]) {
      const skillFile = path.join('skills', directory, 'SKILL.md');
      if (!contractFile(root, skillFile)) {
        continue;
      }
      const skill = readFileSync(path.join(root, skillFile), 'utf8').replace(/\n+$/, '');
      if (skill === '' || !request.prompt.startsWith(`${skill}\n\n`)) {
        continue;
      }
      const schemas = readdirSync(path.join(root, 'skills', directory))
        .filter((file) => file.endsWith('.schema.json'))
        .map((file) => path.join('skills', directory, file));
      if (['creator', 'fixer', 'translator'].includes(role)) {
        schemas.push('skills/_shared/markdown.schema.json');
      }
      for (const schemaFile of schemas) {
        if (!contractFile(root, schemaFile)) {
          continue;
        }
        const schema = JSON.parse(readFileSync(path.join(root, schemaFile), 'utf8')) as JsonObject;
        if (
          canonicalJsonSha256(request.schema) !==
          canonicalJsonSha256(projectCodexJsonSchema(schema).schema)
        ) {
          continue;
        }
        return {
          role,
          stage: path.basename(schemaFile, '.schema.json'),
          contract: {
            source,
            skillFile,
            skillSha256: fileSha256(path.join(root, skillFile)),
            schemaFile,
            sourceSchemaSha256: fileSha256(path.join(root, schemaFile)),
          },
        };
      }
    }
  }
  return { role: 'unknown' };
}

export class LiveProviderJournal {
  private value: LiveProviderProvenance;
  readonly file: string;
  constructor(
    scenario: LiveProviderScenario,
    private readonly frozenRoot: string,
  ) {
    this.file = liveProvenancePath(scenario.workDir);
    this.value = { version: 1, scenario, calls: [] };
    writeFileSync(this.file, '', { flag: 'wx', mode: 0o600 });
    this.persist();
  }
  private persist(): void {
    const contents = JSON.stringify(this.value);
    if (Buffer.byteLength(contents) > 64 * 1024 * 1024) {
      throw new Error('live provider provenance limit exceeded');
    }
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const descriptor = openSync(temporary, 'wx', 0o600);
    try {
      writeFileSync(descriptor, contents);
      fsyncSync(descriptor);
    } finally {
      closeSync(descriptor);
    }
    renameSync(temporary, this.file);
    const directory = openSync(path.dirname(this.file), 'r');
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  request(request: CodexProxyCall): number {
    const id = this.value.calls.length + 1;
    const call: LiveProviderCall = {
      id,
      ...classification(request, this.value.scenario.repositoryRoot, this.frozenRoot),
      ...request,
      promptSha256: sha256(request.prompt),
      schemaSha256: canonicalJsonSha256(request.schema),
      starts: [],
    };
    this.value = { ...this.value, calls: [...this.value.calls, call] };
    this.persist();
    return id;
  }
  role(id: number): LiveProviderRole {
    return this.value.calls.find((call) => call.id === id)?.role ?? 'unknown';
  }
  private update(id: number, update: (call: LiveProviderCall) => LiveProviderCall): void {
    if (!this.value.calls.some((call) => call.id === id)) {
      throw new Error('unknown live provider call');
    }
    this.value = {
      ...this.value,
      calls: this.value.calls.map((call) => (call.id === id ? update(call) : call)),
    };
    this.persist();
  }
  started(id: number, process: ExecutionProcess): void {
    this.update(id, (call) => ({
      ...call,
      starts: [
        ...call.starts,
        {
          pid: process.pid,
          pgid: process.pgid,
          procStartToken: process.procStartToken,
          startedAt: new Date().toISOString(),
        },
      ],
    }));
  }
  completed(id: number, status: number, output: string): void {
    this.update(id, (call) => ({ ...call, status, output, outputSha256: sha256(output) }));
  }
  finish(exitCode: number): void {
    this.value = { ...this.value, completedAt: new Date().toISOString(), exitCode };
    this.persist();
  }
}
