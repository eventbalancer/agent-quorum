import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCli, runCliAsync, type EnvOverrides } from '../helpers/cli.js';
import {
  emptyCritique,
  REPO_ROOT,
  writeCritique,
  writeDefaultPlanLoopConfig,
  writeFakeBin,
  writeStructuredPlanFile,
} from '../helpers/harness.js';
import { startTelegramStub, type TelegramStub } from '../helpers/telegram-stub.js';

let tmp: string;
let fake: string;
let work: string;

function baseEnv(extra: EnvOverrides = {}): EnvOverrides {
  return {
    PATH: `${fake}:${process.env.PATH ?? ''}`,
    PLAN_LOOP_CONFIG_FILE: path.join(tmp, 'plan-loop.json'),
    PLAN_LOOP_WORK_DIR: work,
    PLAN_LOOP_PLANS_DIR: path.join(tmp, 'plans'),
    PLAN_LOOP_STATE_DIR: path.join(tmp, 'state'),
    PLAN_LOOP_CLARIFY: '0',
    PLAN_LOOP_RETRY_COUNT: '0',
    FAKE_CODEX_PROMPT: path.join(tmp, 'codex.prompt'),
    ...extra,
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'plan-loop-clitest.'));
  fake = path.join(tmp, 'bin');
  writeFakeBin(fake);
  work = path.join(tmp, 'work');
  mkdirSync(work);
  mkdirSync(path.join(tmp, 'plans'), { recursive: true });
  mkdirSync(path.join(tmp, 'state'), { recursive: true });
  writeDefaultPlanLoopConfig(path.join(tmp, 'plan-loop.json'));
  writeStructuredPlanFile(path.join(tmp, 'input.md'), 'CLI Input');
  emptyCritique(path.join(tmp, 'empty.json'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('exit-code matrix (AC-3)', () => {
  it('clean converge-at-v0 exits 0 with the AC-2 artifact set', () => {
    const result = runCli(
      ['--effort', 'low', '--iters', '1', path.join(tmp, 'input.md'), '--no-fix', '--no-translate'],
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json') }),
    );
    expect(result.status).toBe(0);
    for (const artifact of [
      'plan.v0.md',
      'critique.v0.json',
      'plan.final.md',
      'findings.json',
      'summary.md',
      'run.meta.tsv',
      'rejected-log.jsonl',
    ]) {
      expect(existsSync(path.join(work, artifact)), artifact).toBe(true);
    }
    expect(result.stderr).toContain('done. summary:');
  });

  it('usage errors exit 1', () => {
    const bogus = runCli(['--bogus', path.join(tmp, 'input.md')], baseEnv());
    expect(bogus.status).toBe(1);
    expect(bogus.stderr).toContain('unknown flag: --bogus');
    expect(bogus.stderr).toContain('usage: plan-loop');

    const missing = runCli([path.join(tmp, 'no-such.md')], baseEnv());
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain(`file not found: ${path.join(tmp, 'no-such.md')}`);
  });

  it('a schema-invalid critique exits 3', () => {
    const invalid = path.join(tmp, 'invalid-critique.json');
    writeCritique(invalid, [{ id: 'BAD' }]);
    const result = runCli(
      ['--effort', 'low', '--iters', '1', path.join(tmp, 'input.md'), '--no-fix', '--no-translate'],
      baseEnv({ FAKE_CODEX_OUTPUT: invalid }),
    );
    expect(result.status).toBe(3);
    expect(result.stderr).toContain('schema validation failed');
  });

  it('an empty creator output in prompt mode exits 4', () => {
    const prompt = path.join(tmp, 'prompt.md');
    writeFileSync(prompt, 'Build the thing.\n');
    const empty = path.join(tmp, 'empty.md');
    writeFileSync(empty, '');
    const result = runCli(
      ['--effort', 'low', '--iters', '1', '--prompt', prompt, '--no-fix', '--no-translate'],
      baseEnv({ FAKE_CLAUDE_MARKDOWN_RESULT: empty }),
    );
    expect(result.status).toBe(4);
  });

  it('a forbidden shell string in the final plan exits 5', () => {
    const violating = path.join(tmp, 'violating.md');
    writeStructuredPlanFile(violating, 'Violating');
    writeFileSync(
      violating,
      `${readFileSync(violating, 'utf8')}\n\`\`\`sh\npnpm -r test\n\`\`\`\n`,
    );
    const result = runCli(
      ['--effort', 'low', '--iters', '1', violating, '--no-fix', '--no-translate'],
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json') }),
    );
    expect(result.status).toBe(5);
    expect(result.stderr).toContain("RULE VIOLATION: plan shell block contains 'pnpm -r'");
  });

  it('a shape-broken final plan exits 6 (blocked)', () => {
    const broken = path.join(tmp, 'broken.md');
    writeFileSync(broken, '# Just a summary\n\n## Context\nNothing else.\n');
    const result = runCli(
      ['--effort', 'low', '--iters', '1', broken, '--no-fix', '--no-translate'],
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json') }),
    );
    expect(result.status).toBe(6);
    expect(result.stderr).toContain('FINAL: blocked');
  });

  it('a clarify /cancel exits 7', async () => {
    const stub: TelegramStub = await startTelegramStub();
    try {
      stub.queueReply(500, '/cancel');
      writeFileSync(
        path.join(work, 'clarify-questions.json'),
        `${JSON.stringify({
          questions: [
            { id: 'Q1', question: 'How many regions?', why: 'important', options: ['One', 'Two'] },
          ],
        })}\n`,
      );
      writeFileSync(path.join(work, 'clarify.offset'), '0');
      const prompt = path.join(tmp, 'prompt.md');
      writeFileSync(prompt, 'Build the thing.\n');
      const result = await runCliAsync(
        ['--effort', 'low', '--iters', '1', '--prompt', prompt, '--no-fix', '--no-translate'],
        baseEnv({
          PLAN_LOOP_CLARIFY: '1',
          PLAN_LOOP_TELEGRAM_BOT_TOKEN: 't',
          PLAN_LOOP_TELEGRAM_CHAT_ID: '42',
          PLAN_LOOP_TELEGRAM_API_BASE: stub.baseUrl,
          PLAN_LOOP_TELEGRAM_POLL_TIMEOUT: '1',
          PLAN_LOOP_CLARIFY_DEADLINE_SECONDS: '5',
        }),
      );
      expect(result.status).toBe(7);
      expect(result.stderr).toContain('operator sent /cancel');
    } finally {
      await stub.close();
    }
  }, 60_000);
});

describe('entry-point dispatch (F12 / AC-1)', () => {
  it('intervene records an entry and rejects bad flags', () => {
    const record = runCli(
      ['intervene', '--work', work, '--target', 'critic', 'check', 'the', 'cutover'],
      baseEnv(),
    );
    expect(record.status).toBe(0);
    expect(record.stdout).toContain('recorded intervention:');
    expect(record.stdout).toContain('target=critic');
    const entry = JSON.parse(
      readFileSync(path.join(work, 'operator-interventions.jsonl'), 'utf8').trim(),
    ) as { target: string; message: string; id: string };
    expect(entry.target).toBe('critic');
    expect(entry.message).toBe('check the cutover');
    expect(entry.id.startsWith('op-')).toBe(true);

    const badTarget = runCli(
      ['intervene', '--work', work, '--target', 'translator', 'x'],
      baseEnv(),
    );
    expect(badTarget.status).toBe(1);
    expect(badTarget.stderr).toContain('invalid target: translator');

    const unknown = runCli(['intervene', '--work', work, '--frobnicate', 'x'], baseEnv());
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain('unknown flag: --frobnicate');

    const missingWork = runCli(['intervene', '--work', path.join(tmp, 'nope'), 'msg'], baseEnv());
    expect(missingWork.status).toBe(2);
    expect(missingWork.stderr).toContain('workdir not found:');

    const viaStdin = runCli(['intervene', '--work', work, '--stdin'], baseEnv(), 'multi\nline\n');
    expect(viaStdin.status).toBe(0);
  });

  it('launch rejects unknown flags with exit 2 and requires input', () => {
    const unknown = runCli(['launch', '--wat'], baseEnv());
    expect(unknown.status).toBe(2);
    expect(unknown.stderr).toContain('unknown flag: --wat');

    const missing = runCli(['launch'], baseEnv());
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain('missing input.md');

    const help = runCli(['launch', '--help'], baseEnv());
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('usage: plan-loop launch');
  });

  it('status rejects an unknown PID with exit 2', () => {
    const result = runCli(['status', '999999'], baseEnv());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('PID 999999 not found');
  });

  it('the core run owns every non-subcommand first argument', () => {
    const result = runCli(
      ['--effort', 'low', '--iters', '1', path.join(tmp, 'input.md'), '--no-fix', '--no-translate'],
      baseEnv({ FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json') }),
    );
    expect(result.status).toBe(0);
  });
});

describe('runner auth preflight', () => {
  it('halts with exit 1 before any provider call when a probe reports unauthenticated', () => {
    const result = runCli(
      ['--effort', 'low', '--iters', '1', path.join(tmp, 'input.md'), '--no-fix', '--no-translate'],
      baseEnv({
        FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
        FAKE_CODEX_LOGIN_STATUS: '1',
      }),
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('codex is installed but not authenticated');
    expect(result.stderr).toContain('codex login');
    expect(existsSync(path.join(tmp, 'codex.prompt'))).toBe(false);
  });

  it('warns and continues when a probe outcome is unknown', () => {
    const result = runCli(
      ['--effort', 'low', '--iters', '1', path.join(tmp, 'input.md'), '--no-fix', '--no-translate'],
      baseEnv({
        FAKE_CODEX_OUTPUT: path.join(tmp, 'empty.json'),
        FAKE_CODEX_LOGIN_STATUS: '3',
      }),
    );
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('could not verify codex authentication');
  });
});

describe('--help / --version', () => {
  it('explicit --help exits 0 with stdout usage and no *.sh names anywhere', () => {
    for (const args of [
      ['--help'],
      ['-h'],
      ['launch', '--help'],
      ['status', '--help'],
      ['intervene', '--help'],
    ]) {
      const result = runCli(args, baseEnv());
      expect(result.status, args.join(' ')).toBe(0);
      expect(result.stdout, args.join(' ')).toContain('plan-loop');
      expect(result.stdout, args.join(' ')).not.toContain('.sh');
    }
    const core = runCli(['--help'], baseEnv());
    expect(core.stdout).toContain('usage: plan-loop');
    expect(core.stdout).toContain('defaults: iters=4 effort=high fix=on translate=off');
  });

  it('--help inside core-run args prints the run usage to stdout and exits 0', () => {
    const result = runCli(['--iters', '1', path.join(tmp, 'input.md'), '--help'], baseEnv());
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('usage: plan-loop');
    expect(result.stdout).not.toContain('.sh');
  });

  it('--version prints the package version', () => {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')) as {
      version: string;
    };
    for (const flag of ['--version', '-V']) {
      const result = runCli([flag], baseEnv());
      expect(result.status, flag).toBe(0);
      expect(result.stdout, flag).toBe(`${pkg.version}\n`);
    }
  });
});
