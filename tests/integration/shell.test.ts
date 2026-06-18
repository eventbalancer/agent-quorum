import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  interveneFromShell,
  launchFromShell,
  stopRun,
  type LaunchResult,
} from '../../src/cli/shell/actions.js';
import {
  defaultRunShellDeps,
  openShellOrHelp,
  runShell,
  shouldOpenShell,
  type RunShellDeps,
  type ShellStreams,
} from '../../src/cli/shell/index.js';
import type { LaunchForm } from '../../src/cli/shell/model.js';
import {
  writeRunRecord,
  type RunRecord,
  type RunRecordDraft,
  type RunStateProbes,
} from '../../src/core/run-store.js';
import type { runLaunchCli } from '../../src/cli/launch.js';
import { pgidOf, procStartToken } from '../../src/runtime/proc.js';

const ENTER_ALT = '\x1b[?1049h';
const EXIT_ALT = '\x1b[?1049l';

let stateDir: string;
let homeDir: string;
let cwdDir: string;
let savedCwd: string;
const savedEnv = new Map<string, string | undefined>();

function setEnv(key: string, value: string | undefined): void {
  savedEnv.set(key, process.env[key]);
  if (value === undefined) {
    Reflect.deleteProperty(process.env, key);
  } else {
    process.env[key] = value;
  }
}

function liveDraft(overrides: Partial<RunRecordDraft> = {}): RunRecordDraft {
  const work = overrides.workDir ?? path.join(stateDir, 'loop-demo');
  return {
    name: 'demo',
    pid: process.pid,
    pgid: pgidOf(process.pid) ?? '0',
    procStartToken: procStartToken(process.pid) ?? 'tok',
    mode: 'plan',
    inputPath: '/tmp/in.md',
    workDir: work,
    logPath: path.join(work, 'run.log'),
    plansDir: '/tmp/plans',
    startedAt: '2026-06-13T00:00:00Z',
    effort: 'high',
    state: 'running',
    ...overrides,
  };
}

function seedRun(name: string, logBody: string): RunRecord {
  const work = path.join(stateDir, `loop-${name}`);
  mkdirSync(work, { recursive: true });
  writeFileSync(path.join(work, 'run.log'), logBody);
  return writeRunRecord(
    stateDir,
    liveDraft({ name, workDir: work, logPath: path.join(work, 'run.log') }),
  );
}

function deadProbes(): RunStateProbes {
  return { isAlive: () => false, pgidOf: () => undefined, procStartToken: () => undefined };
}

function ttyInput(): PassThrough & { isTTY?: boolean } {
  const stream: PassThrough & { isTTY?: boolean } = new PassThrough();
  stream.isTTY = true;
  return stream;
}

class Collector {
  text = '';
  isTTY = true;
  columns = 80;
  rows = 24;
  write(chunk: string): boolean {
    this.text += chunk;
    return true;
  }
}

function streams(input: PassThrough, output: Collector): ShellStreams {
  return { input, output };
}

function deps(overrides: Partial<RunShellDeps> = {}): RunShellDeps {
  return { ...defaultRunShellDeps, followMs: 5, refreshMs: 1_000_000, ...overrides };
}

function flush(ms = 0): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else {
        const st = statSync(full);
        out.push(`${path.relative(root, full)}|${st.size}|${st.mtimeMs}`);
      }
    }
  };
  walk(root);
  return out.sort();
}

beforeEach(() => {
  stateDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-shell.'));
  homeDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-shell-home.'));
  cwdDir = mkdtempSync(path.join(os.tmpdir(), 'agent-quorum-shell-cwd.'));
  savedEnv.clear();
  setEnv('AGENT_QUORUM_STATE_DIR', stateDir);
  setEnv('AGENT_QUORUM_HOME', homeDir);
  setEnv('AGENT_QUORUM_PLANS_DIR', undefined);
  savedCwd = process.cwd();
  process.chdir(cwdDir);
});

afterEach(() => {
  process.chdir(savedCwd);
  for (const [key, value] of savedEnv) {
    if (value === undefined) {
      Reflect.deleteProperty(process.env, key);
    } else {
      process.env[key] = value;
    }
  }
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(homeDir, { recursive: true, force: true });
  rmSync(cwdDir, { recursive: true, force: true });
});

describe('runShell driver', () => {
  it('opens, navigates to detail and logs, returns, and tears down on quit', async () => {
    seedRun('alpha', '[agent-quorum] booting\n');
    const before = snapshot(stateDir);
    const input = ttyInput();
    const output = new Collector();
    const done = runShell(streams(input, output), deps());
    await flush();
    expect(output.text).toContain(ENTER_ALT);
    expect(output.text).toContain('alpha');
    expect(output.text).toContain('running');

    input.write('\r');
    await flush();
    expect(output.text).toContain('Dashboard › alpha');
    expect(output.text).toContain('i intervene');

    input.write('l');
    await flush(20);
    expect(output.text).toContain('booting');
    expect(output.text).toContain('following');

    input.write('b');
    await flush();

    input.write('q');
    const code = await done;
    expect(code).toBe(0);
    expect(output.text).toContain(EXIT_ALT);
    expect(snapshot(stateDir)).toEqual(before);
  });

  it('contains the dead-pid status stderr during detail load (no terminal leak)', async () => {
    seedRun('racing', '[agent-quorum] hi\n');
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    const input = ttyInput();
    const output = new Collector();
    const done = runShell(streams(input, output), deps());
    await flush();
    input.write('\r');
    await flush();

    const leaked = stderrSpy.mock.calls.some((call) => String(call[0]).includes('agent-quorum'));
    input.write('q');
    await done;
    stderrSpy.mockRestore();

    expect(leaked).toBe(false);
    expect(output.text).toContain('process info unavailable');
  });

  it('auto-stops the log follow when the run reaches a terminal state', async () => {
    seedRun('ending', '[agent-quorum] last\n');
    const input = ttyInput();
    const output = new Collector();
    const done = runShell(streams(input, output), deps({ probes: deadProbes() }));
    await flush();
    input.write('\r');
    await flush();
    input.write('l');
    await flush(30);

    expect(output.text).toContain('stopped (terminal)');

    input.write('q');
    expect(await done).toBe(0);
  });

  it('streams appended bytes through the cancellable follow poll', async () => {
    const record = seedRun('streaming', '[agent-quorum] one\n');
    const input = ttyInput();
    const output = new Collector();
    const done = runShell(streams(input, output), deps());
    await flush();
    input.write('\r');
    await flush();
    input.write('l');
    await flush(20);
    const beforeAppend = output.text.length;

    appendFileSync(record.logPath, '[agent-quorum] two\n');
    await flush(30);
    expect(output.text.slice(beforeAppend)).toContain('two');

    input.write('q');
    expect(await done).toBe(0);
  });
});

describe('openShellOrHelp seam', () => {
  it('routes an empty dual-TTY to runShell and a non-TTY to writeHelp', async () => {
    const runSpy = vi.fn(() => Promise.resolve(7));
    const helpSpy = vi.fn();
    const tty = { input: { isTTY: true }, output: { isTTY: true } } as unknown as ShellStreams;
    expect(await openShellOrHelp(tty, { runShell: runSpy, writeHelp: helpSpy })).toBe(7);
    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(helpSpy).not.toHaveBeenCalled();

    runSpy.mockClear();
    helpSpy.mockClear();
    const nonTty = { input: { isTTY: false }, output: { isTTY: false } } as unknown as ShellStreams;
    expect(await openShellOrHelp(nonTty, { runShell: runSpy, writeHelp: helpSpy })).toBe(0);
    expect(helpSpy).toHaveBeenCalledTimes(1);
    expect(runSpy).not.toHaveBeenCalled();
  });

  it('shouldOpenShell is true only for empty args in a dual-TTY', () => {
    expect(shouldOpenShell([], { isTTY: true }, { isTTY: true })).toBe(true);
    expect(shouldOpenShell([], { isTTY: false }, { isTTY: true })).toBe(false);
    expect(shouldOpenShell([], { isTTY: true }, { isTTY: false })).toBe(false);
    expect(shouldOpenShell(['status'], { isTTY: true }, { isTTY: true })).toBe(false);
  });
});

function launchForm(overrides: Partial<LaunchForm> = {}): LaunchForm {
  return {
    input: '',
    promptMode: false,
    resume: false,
    iters: '',
    effort: 'default',
    fix: 'default',
    locale: '',
    translate: 'default',
    field: 0,
    ...overrides,
  };
}

function launchError(result: LaunchResult): string {
  return 'error' in result ? result.error : '';
}

describe('launchFromShell', () => {
  it('rejects blank, non-file input and bad iters without calling the engine', async () => {
    let calls = 0;
    const engine: typeof runLaunchCli = () => {
      calls += 1;
      return Promise.resolve({ exitCode: 0 });
    };
    const dir = path.join(stateDir, 'a-dir');
    mkdirSync(dir);
    expect(
      launchError(
        await launchFromShell(launchForm({ input: '' }), () => undefined, { runLaunch: engine }),
      ),
    ).toContain('input is required');
    expect(
      launchError(
        await launchFromShell(
          launchForm({ input: path.join(stateDir, 'nope.md') }),
          () => undefined,
          {
            runLaunch: engine,
          },
        ),
      ),
    ).toContain('not a readable file');
    expect(
      launchError(
        await launchFromShell(launchForm({ input: dir }), () => undefined, { runLaunch: engine }),
      ),
    ).toContain('not a readable file');
    const file = path.join(stateDir, 'task.md');
    writeFileSync(file, '# task\n');
    expect(
      launchError(
        await launchFromShell(launchForm({ input: file, iters: '0' }), () => undefined, {
          runLaunch: engine,
        }),
      ),
    ).toContain('iters');
    expect(calls).toBe(0);
  });

  it('maps the form fields to the engine arg vector', async () => {
    const file = path.join(stateDir, 'task.md');
    writeFileSync(file, '# task\n');
    let seen: string[] = [];
    const engine: typeof runLaunchCli = (args) => {
      seen = [...args];
      return Promise.resolve({
        exitCode: 0,
        runId: 'r1',
        name: 'task',
        pid: 1,
        workDir: '/w',
        logPath: '/w/run.log',
      });
    };
    await launchFromShell(
      launchForm({
        input: file,
        iters: '3',
        effort: 'max',
        fix: 'on',
        locale: 'ru',
        translate: 'off',
      }),
      () => undefined,
      { runLaunch: engine },
    );
    expect(seen).toEqual([
      file,
      '--iters',
      '3',
      '--effort',
      'max',
      '--fix',
      '--locale',
      'ru',
      '--no-translate',
    ]);
  });

  it('keeps the input on resume and derives the name from the workdir', async () => {
    const file = path.join(stateDir, 'resume.md');
    writeFileSync(file, '# task\n');
    let seen: string[] = [];
    const engine: typeof runLaunchCli = (args) => {
      seen = [...args];
      return Promise.resolve({
        exitCode: 0,
        pid: 9,
        workDir: '/tmp/loop-myrun',
        logPath: '/tmp/loop-myrun/run.log',
      });
    };
    const result = await launchFromShell(
      launchForm({ input: file, resume: true, promptMode: true }),
      () => undefined,
      { runLaunch: engine },
    );
    expect(seen[0]).toBe('--resume');
    expect(seen).toContain('--prompt');
    expect('error' in result).toBe(false);
    if (!('error' in result)) {
      expect(result.name).toBe('myrun');
    }
  });
});

describe('interveneFromShell', () => {
  it('appends one intervention line via the CLI engine', () => {
    const work = path.join(stateDir, 'loop-intv');
    mkdirSync(work, { recursive: true });
    const record = writeRunRecord(
      stateDir,
      liveDraft({ name: 'intv', workDir: work, logPath: path.join(work, 'run.log') }),
    );
    const result = interveneFromShell(
      { record, target: 'critic', message: 'please refocus' },
      () => undefined,
    );
    expect(result.code).toBe(0);
    const lines = readFileSync(path.join(work, 'operator-interventions.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0] ?? '{}') as { target: string; message: string };
    expect(parsed.target).toBe('critic');
    expect(parsed.message).toBe('please refocus');
  });
});

describe('stopRun', () => {
  function stopRecord(): RunRecord {
    return {
      runId: 'r1-a',
      name: 'victim',
      pid: 999,
      pgid: '4242',
      procStartToken: 'tok',
      mode: 'plan',
      inputPath: '/i.md',
      workDir: '/w',
      logPath: '/w/run.log',
      plansDir: '/p',
      startedAt: '2026-06-13T00:00:00Z',
      effort: 'high',
      state: 'running',
    };
  }
  const liveProbes: RunStateProbes = {
    isAlive: () => true,
    pgidOf: () => '4242',
    procStartToken: () => 'tok',
  };

  it('aborts without signaling when the run is no longer live', () => {
    const calls: number[] = [];
    const result = stopRun(stopRecord(), { probes: deadProbes(), kill: (pid) => calls.push(pid) });
    expect(result.kind).toBe('aborted');
    expect(calls).toHaveLength(0);
  });

  it('signals the process group once for a live run', () => {
    const calls: [number, NodeJS.Signals | number][] = [];
    const result = stopRun(stopRecord(), {
      probes: liveProbes,
      kill: (pid, signal) => calls.push([pid, signal]),
    });
    expect(result).toEqual({ kind: 'killed', command: 'kill -TERM -4242' });
    expect(calls).toEqual([[-4242, 'SIGTERM']]);
  });

  it('surfaces a kill failure as an error without throwing', () => {
    const result = stopRun(stopRecord(), {
      probes: liveProbes,
      kill: () => {
        throw new Error('EPERM');
      },
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') {
      expect(result.message).toContain('EPERM');
    }
  });
});

describe('runShell actions', () => {
  it('records an intervention driven through the form', async () => {
    const record = seedRun('formintv', '[agent-quorum] hi\n');
    const input = ttyInput();
    const output = new Collector();
    const done = runShell(streams(input, output), deps());
    await flush();
    input.write('\r');
    await flush();
    input.write('i');
    await flush();
    input.write('\t');
    await flush();
    for (const ch of 'ping') {
      input.write(ch);
    }
    await flush();
    input.write('\r');
    await flush();
    input.write('q');
    await done;

    const lines = readFileSync(path.join(record.workDir, 'operator-interventions.jsonl'), 'utf8')
      .trim()
      .split('\n');
    expect(lines).toHaveLength(1);
    expect((JSON.parse(lines[0] ?? '{}') as { message: string }).message).toBe('ping');
  });

  it('launches through the form and surfaces the identity via reload', async () => {
    seedRun('existing', '[agent-quorum] x\n');
    let launched = 0;
    const launchAction: RunShellDeps['launchAction'] = () => {
      launched += 1;
      return Promise.resolve({
        exitCode: 0,
        runId: 'rNEW',
        name: 'fresh',
        pid: 5,
        workDir: '/w',
        logPath: '/w/run.log',
      });
    };
    const input = ttyInput();
    const output = new Collector();
    const done = runShell(streams(input, output), deps({ launchAction }));
    await flush();
    input.write('n');
    await flush();
    input.write('\r');
    await flush();
    input.write('q');
    await done;
    expect(launched).toBe(1);
    expect(output.text).toContain('fresh');
  });

  it('signals a stop only after an exact typed-name confirmation', async () => {
    seedRun('victim', '[agent-quorum] x\n');
    const stopped: RunRecord[] = [];
    const stopAction: RunShellDeps['stopAction'] = (record) => {
      stopped.push(record);
      return { kind: 'killed', command: `kill -TERM -${record.pgid}` };
    };
    const input = ttyInput();
    const output = new Collector();
    const done = runShell(streams(input, output), deps({ stopAction }));
    await flush();
    input.write('\r');
    await flush();
    input.write('s');
    await flush();
    for (const ch of 'wrong') {
      input.write(ch);
    }
    await flush();
    input.write('\r');
    await flush();
    expect(stopped).toHaveLength(0);

    Array.from('wrong', () => input.write('\x7f'));
    await flush();
    for (const ch of 'victim') {
      input.write(ch);
    }
    await flush();
    input.write('\r');
    await flush();
    expect(stopped).toHaveLength(1);
    expect(stopped[0]?.name).toBe('victim');

    input.write('q');
    await done;
  });
});

describe('layer boundary', () => {
  it('keeps src/cli modules from importing the public barrel src/index.ts', () => {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const cliRoot = path.resolve(here, '../../src/cli');
    const barrel = path.resolve(here, '../../src/index.ts');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (full.endsWith('.ts')) {
          files.push(full);
        }
      }
    };
    walk(cliRoot);
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const barrelImport = path.relative(path.dirname(file), barrel).replace(/\.ts$/, '.js');
      expect(text.includes(`'${barrelImport}'`)).toBe(false);
      expect(text.includes(`"${barrelImport}"`)).toBe(false);
    }
  });
});
