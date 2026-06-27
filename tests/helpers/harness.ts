import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { JsonObject, JsonValue } from '../../src/core/json.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILLS_DIR = path.join(REPO_ROOT, 'skills');
const FAKE_BIN_FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-bin');

interface PlanFrontmatterPhase {
  readonly name: string;
  readonly effort: string;
}

function planFrontmatterLines(
  phaseCount: number,
  effortTotal: string,
  phases: readonly PlanFrontmatterPhase[],
  status = 'clean',
): string[] {
  return [
    '---',
    `phase_count: ${phaseCount}`,
    `effort_total: "${effortTotal}"`,
    'phases:',
    ...phases.flatMap((phase) => [`  - name: "${phase.name}"`, `    effort: "${phase.effort}"`]),
    `status: ${status}`,
    '---',
    '',
  ];
}

export function writeFakeBin(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ['codex', 'claude', 'cursor-agent', 'ajv', 'pnpm']) {
    const target = path.join(dir, name);
    copyFileSync(path.join(FAKE_BIN_FIXTURES, name), target);
    chmodSync(target, 0o755);
  }
}

export function writeStructuredPlanFile(
  file: string,
  title: string,
  opts: { frontmatter?: boolean } = {},
): void {
  const withFrontmatter = opts.frontmatter !== false;
  const header = withFrontmatter
    ? planFrontmatterLines(1, '~1h', [{ name: 'P1 — Fixture Phase', effort: '~1h' }])
    : [];
  const workPlan = withFrontmatter
    ? [
        '## Work Plan',
        '',
        '| Phase | Touches | Depends on | Effort | Acceptance gate |',
        '| --- | --- | --- | --- | --- |',
        '| P1 — Fixture Phase | `fixture.md` | — | ~1h | fixture gate observable |',
        '',
      ]
    : ['## Work Plan', '1. Fixture step.', ''];
  const body = [
    ...header,
    `# ${title}`,
    '',
    '## At a Glance',
    '- Outcome: fixture plan.',
    '- Blast radius: fixture.',
    '- Work Plan phases: 1.',
    '',
    '## Context',
    '- Fixture context.',
    '',
    '## Verified Facts',
    '- Fixture fact.',
    '',
    '## Target State',
    '- Fixture target.',
    '',
    '## Scope',
    '- In scope: fixture.',
    '- Out of scope: fixture.',
    '',
    ...workPlan,
    '## Files and Interfaces',
    '- `fixture.md`',
    '',
    '## Verification',
    '- Fixture verification.',
    '',
    '## STOP Triggers',
    '- Pause on fixture contradiction.',
    '',
    '## Impact Graph',
    '',
    '```mermaid',
    'flowchart TD',
    '  A["fixture input"] -->|"direct: fixture"| B["fixture plan"]',
    '```',
    '',
  ].join('\n');
  writeFileSync(file, body);
}

// A structurally complex plan: a `Phase | Touches | Depends on | Effort |
// Acceptance gate` table plus matching `### P#` detail subsections,
// Files/Verification/STOP sections, and non-goals/Open Questions — enough to
// exercise the table-branch parser and the package emitter.
export function writeLargeStructuredPlanFile(
  file: string,
  title: string,
  phaseCount = 6,
  startIndex = 1,
): void {
  const rows: string[] = [];
  const details: string[] = [];
  const verification: string[] = [];
  const files: string[] = [];
  const phaseEntries: PlanFrontmatterPhase[] = [];
  for (let i = startIndex; i < startIndex + phaseCount; i += 1) {
    const dep = i === startIndex ? 'requirements' : `P${i - 1}`;
    rows.push(
      `| P${i} Phase ${i} work | \`src/core/mod-${i}.ts\` | ${dep} | ~1h | Phase ${i} gate observable |`,
    );
    details.push(
      `### P${i} — Phase ${i} work`,
      '',
      `- Edit \`src/core/mod-${i}.ts\` to add the phase ${i} behavior.`,
      `- Acceptance gate: phase ${i} gate observable.`,
      '',
    );
    verification.push(`- P${i}: \`pnpm run test\` proves phase ${i} gate observable.`);
    files.push(`- \`src/core/mod-${i}.ts\``);
    phaseEntries.push({ name: `P${i} Phase ${i} work`, effort: '~1h' });
  }
  const body = [
    ...planFrontmatterLines(phaseCount, `~${phaseCount}h`, phaseEntries),
    `# ${title}`,
    '',
    '## At a Glance',
    `- Outcome: large fixture plan with ${phaseCount} phases.`,
    '- Blast radius: fixture.',
    `- Work Plan phases: ${phaseCount}.`,
    '- Biggest risk: fixture risk.',
    '',
    '## Context',
    '- Large fixture context.',
    '',
    '## Verified Facts',
    '- Fixture fact at `package.json:1`.',
    '',
    '## Target State',
    '- Fixture target.',
    '',
    '## Scope',
    'In scope: fixture work.',
    '',
    'Non-goals:',
    '',
    '- Fixture out-of-scope item.',
    '',
    '## Work Plan',
    '',
    '| Phase | Touches | Depends on | Effort | Acceptance gate |',
    '| --- | --- | --- | --- | --- |',
    ...rows,
    '',
    ...details,
    '## Files and Interfaces',
    '',
    ...files,
    '',
    '## Verification',
    '',
    ...verification,
    '',
    '## STOP Triggers',
    '- Halt on fixture contradiction.',
    '',
    '## Open Questions',
    '- Fixture open question.',
    '',
    '## Impact Graph',
    '',
    '```mermaid',
    'flowchart TD',
    '  A["fixture input"] -->|"direct: fixture"| B["fixture plan"]',
    '```',
    '',
  ].join('\n');
  writeFileSync(file, body);
}

function writeJsonFixture(file: string, value: JsonValue): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

export function writeCritique(file: string, issues: JsonValue[]): void {
  writeJsonFixture(file, { plan_version: 0, summary: 'fixture critique', issues });
}

export function emptyCritique(file: string): void {
  writeCritique(file, []);
}

export function writeUpdate(file: string, version: number, markdown = '# Next plan'): void {
  writeJsonFixture(file, {
    plan_version: version,
    plan_markdown: markdown,
    issues: [],
    applied: [],
    rejected_append: [],
  });
}

export function writeUpdateMeta(file: string, version: number): void {
  writeJsonFixture(file, { plan_version: version, issues: [], applied: [], rejected_append: [] });
}

export function writeAcceptUpdate(
  file: string,
  version: number,
  markdownFile: string,
  issue = 'C1',
): void {
  writeJsonFixture(file, {
    plan_version: version,
    plan_markdown: readFileSync(markdownFile, 'utf8'),
    issues: [
      {
        id: issue,
        verdict: 'accept',
        verdict_reason: 'fixture',
        final_severity: 'major',
        duplicate_of: null,
      },
    ],
    applied: [issue],
    rejected_append: [],
  });
}

// A codex markdown-mode role returns a {plan_markdown: "..."} wrapper with
// edge characters that force JSON-escaping round-trips.
export function writeMarkdownWrapper(file: string, title: string): void {
  const tmpPlan = `${file}.plan-tmp`;
  writeStructuredPlanFile(tmpPlan, title);
  const markdown = `${readFileSync(tmpPlan, 'utf8')}\n- Edge chars: "quoted" and backslash \\ and path C:\\\\dir.\n`;
  writeJsonFixture(file, { plan_markdown: markdown });
}

// Parse the NUL-separated, \x1e-record argv log written by the fake bins.
export function argvRecords(file: string): string[][] {
  let buf: Buffer;
  try {
    buf = readFileSync(file);
  } catch {
    return [];
  }
  const records: string[][] = [];
  let record: string[] = [];
  let field: number[] = [];
  for (const byte of buf) {
    if (byte === 0) {
      record.push(Buffer.from(field).toString('utf8'));
      field = [];
    } else if (byte === 0x1e) {
      if (field.length > 0) {
        record.push(Buffer.from(field).toString('utf8'));
        field = [];
      }
      records.push(record);
      record = [];
    } else {
      field.push(byte);
    }
  }
  if (field.length > 0) {
    record.push(Buffer.from(field).toString('utf8'));
  }
  if (record.length > 0) {
    records.push(record);
  }
  return records;
}

export function defaultPlanLoopConfig(): JsonObject {
  return {
    version: 1,
    settings: {
      iters: 4,
      quality: 'balanced',
      fix: true,
      translate: false,
      diffThreshold: 5,
      retryCount: 3,
      retryDelaySeconds: 10,
    },
    roles: {
      creator: {
        runner: 'claude',
        model: 'claude-opus-4-8',
        createTools: ['Read', 'Grep', 'Glob'],
        createDisallowedTools: [
          'Write',
          'Edit',
          'NotebookEdit',
          'Agent',
          'Task',
          'ToolSearch',
          'AskUserQuestion',
        ],
        updateTools: ['Read'],
        updateDisallowedTools: [
          'Write',
          'Bash',
          'Edit',
          'NotebookEdit',
          'Agent',
          'Task',
          'ToolSearch',
          'AskUserQuestion',
        ],
      },
      critic: {
        runner: 'codex',
        model: 'gpt-5.5',
        tools: ['Read', 'Grep', 'Glob'],
        disallowedTools: [
          'Write',
          'Edit',
          'NotebookEdit',
          'Bash',
          'Agent',
          'Task',
          'ToolSearch',
          'AskUserQuestion',
        ],
      },
      fixer: {
        runner: 'claude',
        model: 'claude-opus-4-8',
        tools: ['Read', 'Grep', 'Glob'],
        disallowedTools: [
          'Edit',
          'Write',
          'NotebookEdit',
          'Bash',
          'Agent',
          'Task',
          'ToolSearch',
          'AskUserQuestion',
        ],
      },
      reviewer: {
        runner: 'codex',
        model: 'gpt-5.5',
        tools: ['Read', 'Grep', 'Glob'],
        disallowedTools: [
          'Write',
          'Edit',
          'NotebookEdit',
          'Bash',
          'Agent',
          'Task',
          'ToolSearch',
          'AskUserQuestion',
        ],
      },
      translator: {
        runner: 'claude',
        model: 'claude-sonnet-4-6',
        tools: ['Read', 'Grep', 'Glob'],
        disallowedTools: [
          'Write',
          'Edit',
          'NotebookEdit',
          'Bash',
          'Agent',
          'Task',
          'ToolSearch',
          'AskUserQuestion',
        ],
      },
    },
  };
}

// Role specs use the harness form "role:runner[:model]".
function planLoopConfigWithRoles(...specs: string[]): JsonObject {
  const config = defaultPlanLoopConfig();
  const roles = config.roles as Record<string, JsonObject>;
  for (const spec of specs) {
    const [role, runner, model] = spec.split(':');
    if (!role) {
      continue;
    }
    const target = roles[role];
    if (target === undefined) {
      continue;
    }
    if (runner) {
      target.runner = runner;
    }
    if (model) {
      target.model = model;
    }
  }
  return config;
}

export function storeConfigPath(home: string): string {
  return path.join(home, 'config.json');
}

// Persist the operator config under a temp store home — the AGENT_QUORUM_HOME
// per-user store that replaced the legacy package-root config channels.
export function writeStoreConfig(home: string, config: JsonObject = defaultPlanLoopConfig()): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(storeConfigPath(home), `${JSON.stringify(config, null, 2)}\n`);
}

export function writeStoreConfigRoles(home: string, ...specs: string[]): void {
  writeStoreConfig(home, planLoopConfigWithRoles(...specs));
}

export interface StderrCapture {
  readonly text: () => string;
  readonly restore: () => void;
}

type MaybePromise<T> = T | Promise<T>;
type EnvOverrides = Readonly<Record<string, string | undefined>>;
type EnvSnapshot = Map<string, string | undefined>;

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

export function stripAnsi(text: string): string {
  return text.replace(ANSI_PATTERN, '');
}

export function captureStderr(): StderrCapture {
  let buffer = '';
  const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
    buffer += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString();
    return true;
  });
  return {
    text: () => stripAnsi(buffer),
    restore: () => {
      spy.mockRestore();
    },
  };
}

function snapshotEnv(vars: EnvOverrides): EnvSnapshot {
  const saved: EnvSnapshot = new Map();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  return saved;
}

function restoreEnv(saved: EnvSnapshot): void {
  for (const [key, value] of saved) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
}

export function withEnv<T>(vars: EnvOverrides, fn: () => T): T {
  const saved = snapshotEnv(vars);
  try {
    return fn();
  } finally {
    restoreEnv(saved);
  }
}

export async function withEnvAsync<T>(vars: EnvOverrides, fn: () => MaybePromise<T>): Promise<T> {
  const saved = snapshotEnv(vars);
  try {
    return await Promise.resolve(fn());
  } finally {
    restoreEnv(saved);
  }
}

export function withCwd<T>(dir: string, fn: () => T): T {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return fn();
  } finally {
    process.chdir(saved);
  }
}

export async function withCwdAsync<T>(dir: string, fn: () => MaybePromise<T>): Promise<T> {
  const saved = process.cwd();
  process.chdir(dir);
  try {
    return await Promise.resolve(fn());
  } finally {
    process.chdir(saved);
  }
}
