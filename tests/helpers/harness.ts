import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { vi } from 'vitest';
import type { JsonObject, JsonValue } from '../../src/core/json.js';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SKILLS_DIR = path.join(REPO_ROOT, 'skills');
const FAKE_BIN_FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures', 'fake-bin');

export function writeFakeBin(dir: string): void {
  mkdirSync(dir, { recursive: true });
  for (const name of ['codex', 'claude', 'cursor-agent', 'ajv', 'pnpm']) {
    const target = path.join(dir, name);
    copyFileSync(path.join(FAKE_BIN_FIXTURES, name), target);
    chmodSync(target, 0o755);
  }
}

export function writeStructuredPlanFile(file: string, title: string): void {
  const body = [
    `# ${title}`,
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
    '## Work Plan',
    '1. Fixture step.',
    '',
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
      effort: 'high',
      fix: true,
      translate: false,
      diffThreshold: 5,
      retryCount: 3,
      retryDelaySeconds: 10,
    },
    roles: {
      critic: {
        runner: 'codex',
        model: 'gpt-5.5',
        reasoning: 'xhigh',
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
      creator: {
        runner: 'claude',
        model: 'claude-opus-4-8',
        reasoning: 'xhigh',
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
      fixer: {
        runner: 'claude',
        model: 'claude-opus-4-8',
        reasoning: 'xhigh',
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
        reasoning: 'xhigh',
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
        reasoning: 'high',
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

export function writeDefaultPlanLoopConfig(file: string): void {
  writeFileSync(file, `${JSON.stringify(defaultPlanLoopConfig(), null, 2)}\n`);
}

// Role specs use the harness form "role:runner[:model[:reasoning]]".
export function writePlanLoopConfig(file: string, ...specs: string[]): void {
  const config = defaultPlanLoopConfig();
  const roles = config.roles as Record<string, JsonObject>;
  for (const spec of specs) {
    const [role, runner, model, reasoning] = spec.split(':');
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
    if (reasoning) {
      target.reasoning = reasoning;
    }
  }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
}

export interface StderrCapture {
  text: () => string;
  restore: () => void;
}

type MaybePromise<T> = T | Promise<T>;

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

export function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  const restore = () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  };
  try {
    const result = fn();
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

export async function withEnvAsync<T>(
  vars: Record<string, string | undefined>,
  fn: () => MaybePromise<T>,
): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(vars)) {
    saved.set(key, process.env[key]);
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await Promise.resolve(fn());
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  }
}
