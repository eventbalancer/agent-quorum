import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { HaltError } from '../runtime/halt.js';
import { colorsEnabled } from '../runtime/log.js';
import { packageRoot } from '../runtime/env.js';
import { fileLineCount, nonEmptyFile } from '../runtime/files.js';
import { critiqueHealth } from '../core/metrics.js';
import { isJsonObject, type JsonObject, type JsonValue } from '../core/json.js';
import { STATUS_USAGE } from './help.js';

function ps(args: string[]): string {
  try {
    const result = spawnSync('ps', args, { encoding: 'utf8' });
    if (result.status !== 0) {
      return '';
    }
    return result.stdout;
  } catch {
    return '';
  }
}

function psField(pid: number, field: string): string {
  return ps(['-p', String(pid), '-o', `${field}=`]).trim();
}

function ppidOf(pid: number): number | undefined {
  if (process.platform === 'linux') {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2);
      const ppid = Number(afterComm.split(' ')[1]);
      return Number.isInteger(ppid) ? ppid : undefined;
    } catch {
      return undefined;
    }
  }
  const out = psField(pid, 'ppid');
  if (!/^[0-9]+$/.test(out)) {
    return undefined;
  }
  return Number(out);
}

function commandOf(pid: number): string {
  return ps(['-p', String(pid), '-o', 'command=']).replace(/\n$/, '');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function baseToken(token: string): string {
  const stripped = token.endsWith('/') ? token.slice(0, -1) : token;
  return stripped.split('/').pop() ?? '';
}

function statusStateDirCandidates(): string[] {
  if (process.env.PLAN_LOOP_STATE_DIR) {
    return [process.env.PLAN_LOOP_STATE_DIR];
  }
  if (process.env.PLAN_LOOP_PLANS_DIR) {
    return [path.join(process.env.PLAN_LOOP_PLANS_DIR, '.runs')];
  }
  return [path.join(os.homedir(), '.claude', 'plans', '.runs')];
}

function readMetaValue(file: string, key: string): string | undefined {
  if (!existsSync(file)) {
    return undefined;
  }
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const tab = line.indexOf('\t');
    if (tab === -1) {
      continue;
    }
    if (line.slice(0, tab) === key) {
      return line.slice(tab + 1);
    }
  }
  return undefined;
}

function registryPids(dirs: readonly string[]): Set<number> {
  const pids = new Set<number>();
  for (const dir of dirs) {
    if (!existsSync(dir)) {
      continue;
    }
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.tsv')) {
        continue;
      }
      const pid = readMetaValue(path.join(dir, name), 'pid');
      if (pid !== undefined && /^[0-9]+$/.test(pid)) {
        pids.add(Number(pid));
      }
    }
  }
  return pids;
}

// Command-shape root check: the port's runner sets process.title =
// 'plan-loop', so ps shows it as the first token (a payload-matching process
// whose arguments merely mention plan-loop never passes).
function commandIsPlanLoopRoot(pid: number): boolean {
  const cmd = commandOf(pid);
  if (cmd === '') {
    return false;
  }
  const tokens = cmd.split(/\s+/).filter((token) => token !== '');
  const first = baseToken(tokens[0] ?? '');
  const second = baseToken(tokens[1] ?? '');
  if (first === 'plan-loop' || first === 'plan-loop.sh') {
    return true;
  }
  if (['bash', 'sh', 'zsh', 'node'].includes(first)) {
    if (second === 'plan-loop.sh' || second === 'plan-loop') {
      return true;
    }
  }
  return false;
}

function findRootPlanLoop(pid: number): number | undefined {
  let cur: number | undefined = pid;
  let last: number | undefined;
  while (cur !== undefined && cur !== 0 && cur !== 1) {
    if (commandIsPlanLoopRoot(cur)) {
      last = cur;
    }
    cur = ppidOf(cur);
  }
  return last;
}

function extractInputPath(cmdline: string): string {
  let prev = '';
  let promptInput = '';
  let positionalInput = '';
  for (const tok of cmdline.split(/\s+/)) {
    if (prev === '--prompt') {
      promptInput = tok;
    } else if (tok.endsWith('.md') && prev !== '--iters' && prev !== '--max-iters') {
      positionalInput = tok;
    }
    prev = tok;
  }
  return promptInput !== '' ? promptInput : positionalInput;
}

function processEnvVar(root: number, key: string): string | undefined {
  if (process.platform === 'linux') {
    try {
      const environ = readFileSync(`/proc/${root}/environ`, 'utf8');
      for (const entry of environ.split('\0')) {
        if (entry.startsWith(`${key}=`)) {
          return entry.slice(key.length + 1);
        }
      }
    } catch {
      /* fall through to ps */
    }
  }
  const cmdline = ps(['eww', '-p', String(root), '-o', 'command=']);
  if (cmdline === '') {
    return undefined;
  }
  const match = new RegExp(`(?:^|\\s)${key}=(.*?)(?=\\s[A-Za-z_][A-Za-z0-9_]*=|$)`, 's').exec(
    cmdline.replace(/\n$/, ''),
  );
  return match?.[1];
}

function stateDirCandidates(root: number): string[] {
  const dirs: string[] = [];
  if (process.env.PLAN_LOOP_STATE_DIR) {
    dirs.push(process.env.PLAN_LOOP_STATE_DIR);
  }
  const envState = processEnvVar(root, 'PLAN_LOOP_STATE_DIR');
  if (envState !== undefined && envState !== '') {
    dirs.push(envState);
  }
  if (process.env.PLAN_LOOP_PLANS_DIR) {
    dirs.push(path.join(process.env.PLAN_LOOP_PLANS_DIR, '.runs'));
  }
  const envPlans = processEnvVar(root, 'PLAN_LOOP_PLANS_DIR');
  if (envPlans !== undefined && envPlans !== '') {
    dirs.push(path.join(envPlans, '.runs'));
  }
  dirs.push(path.join(os.homedir(), '.claude', 'plans', '.runs'));
  return [...new Set(dirs)];
}

function canonicalDir(dir: string): string {
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) {
      return path.resolve(dir);
    }
  } catch {
    /* keep raw */
  }
  return dir;
}

function canonicalFile(file: string): string {
  if (existsSync(file)) {
    return path.resolve(file);
  }
  return file;
}

function registryWorkDir(root: number, input: string): string | undefined {
  const canonicalInput = input !== '' && existsSync(input) ? canonicalFile(input) : '';
  for (const dir of stateDirCandidates(root)) {
    const file = path.join(dir, `${root}.tsv`);
    if (!existsSync(file)) {
      continue;
    }
    const pid = readMetaValue(file, 'pid');
    if (pid !== undefined && pid !== '' && pid !== String(root)) {
      continue;
    }
    const metaInput = readMetaValue(file, 'input_path');
    if (
      metaInput !== undefined &&
      metaInput !== '' &&
      canonicalInput !== '' &&
      metaInput !== canonicalInput
    ) {
      continue;
    }
    const work = readMetaValue(file, 'work_dir');
    if (work !== undefined && work !== '') {
      return work;
    }
  }
  return undefined;
}

function processLogWorkDir(root: number): string | undefined {
  try {
    const result = spawnSync('lsof', ['-p', String(root), '-Fn'], { encoding: 'utf8' });
    if (result.error) {
      return undefined;
    }
    for (const line of (result.stdout || '').split('\n')) {
      if (!line.startsWith('n')) {
        continue;
      }
      const p = line.slice(1);
      if (p.endsWith('/run.log')) {
        return path.dirname(p);
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function defaultWorkDirFromInput(input: string, plansDir: string): string | undefined {
  if (input === '') {
    return undefined;
  }
  const abs = existsSync(input) ? canonicalFile(input) : input;
  const base = path.basename(abs, path.extname(abs));
  return path.join(plansDir, `loop-${base}`);
}

function resolveWorkDir(root: number, input: string): string | undefined {
  const fromRegistry = registryWorkDir(root, input);
  if (fromRegistry !== undefined) {
    return canonicalDir(fromRegistry);
  }
  const fromLog = processLogWorkDir(root);
  if (fromLog !== undefined) {
    return canonicalDir(fromLog);
  }
  const fromEnv = processEnvVar(root, 'PLAN_LOOP_WORK_DIR');
  if (fromEnv !== undefined && fromEnv !== '') {
    return canonicalDir(fromEnv);
  }
  const envPlans = processEnvVar(root, 'PLAN_LOOP_PLANS_DIR');
  if (envPlans !== undefined && envPlans !== '') {
    const work = defaultWorkDirFromInput(input, envPlans);
    if (work !== undefined) {
      return canonicalDir(work);
    }
  }
  const plansDir = process.env.PLAN_LOOP_PLANS_DIR ?? path.join(os.homedir(), '.claude', 'plans');
  const work = defaultWorkDirFromInput(input, plansDir);
  if (work === undefined) {
    return undefined;
  }
  return canonicalDir(work);
}

interface Palette {
  B: string;
  R: string;
  RED: string;
  YEL: string;
  GRN: string;
  DIM: string;
}

function palette(): Palette {
  if (colorsEnabled(process.stdout)) {
    return {
      B: '\x1b[1m',
      R: '\x1b[0m',
      RED: '\x1b[31m',
      YEL: '\x1b[33m',
      GRN: '\x1b[32m',
      DIM: '\x1b[2m',
    };
  }
  return { B: '', R: '', RED: '', YEL: '', GRN: '', DIM: '' };
}

function strippedLogLines(logPath: string): string[] {
  if (!existsSync(logPath)) {
    return [];
  }
  const ansiPattern = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
  return readFileSync(logPath, 'utf8')
    .split('\n')
    .map((line) => line.replace(ansiPattern, ''))
    .filter((line) => line.startsWith('[plan-loop]'));
}

function phaseActiveRole(logPath: string): string {
  const lines = strippedLogLines(logPath).filter((line) =>
    /iter=[0-9]+ — (critic|creator)|creating plan v0 from prompt|fix-pass: step [0-9]+ —/.test(
      line,
    ),
  );
  const line = lines[lines.length - 1];
  if (line === undefined) {
    return '';
  }
  if (line.includes('— critic ')) {
    return 'critic';
  }
  if (line.includes('creator update')) {
    return 'creator';
  }
  if (line.includes('creating plan v0')) {
    return 'creator';
  }
  if (line.includes(' propose ') || line.includes(' apply ')) {
    return 'fixer';
  }
  if (line.includes(' review ')) {
    return 'reviewer';
  }
  return '';
}

function childrenOf(pid: number): number[] {
  const out = ps(['-axo', 'pid=,ppid=']);
  const kids: number[] = [];
  for (const line of out.split('\n')) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) {
      continue;
    }
    if (Number(parts[1]) === pid) {
      kids.push(Number(parts[0]));
    }
  }
  return kids;
}

function printTreeChildren(
  root: number,
  logPath: string,
  pal: Palette,
  write: (s: string) => void,
): void {
  const phaseRole = logPath === '' ? '' : phaseActiveRole(logPath);
  const kids = childrenOf(root);
  if (kids.length === 0) {
    write(`    ${pal.DIM}(none — between phases)${pal.R}\n`);
    return;
  }
  for (const pid of kids) {
    const cmd = commandOf(pid).slice(0, 50);
    const elapsed = psField(pid, 'etime');
    write(`    ${pid}  (${elapsed})  ${pal.DIM}${cmd}...${pal.R}\n`);
    for (const spid of childrenOf(pid)) {
      const scmd = commandOf(spid).slice(0, 50);
      const sel = psField(spid, 'etime');
      let type = '?';
      if (scmd.startsWith('claude')) {
        type = phaseRole || 'creator';
      } else if (scmd.startsWith('codex')) {
        type = phaseRole || 'critic';
      } else if (scmd.startsWith('awk')) {
        type = 'log-filter';
      } else if (scmd.startsWith('tee')) {
        type = 'tee';
      } else if (scmd.startsWith('jq')) {
        type = 'jq';
      } else if (scmd.startsWith('bash')) {
        type = 'subshell';
      }
      write(`      └─ ${spid}  (${sel}, ${type})\n`);
    }
  }
}

function readJsonObject(file: string): JsonObject | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as JsonValue;
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function pad(value: string, width: number): string {
  return value.length >= width ? value : value + ' '.repeat(width - value.length);
}

// FR-13: the per-iteration table is computed from $WORK artifacts via the
// health metric; run.log feeds only the last-event line.
function printIterTable(work: string, pal: Palette, write: (s: string) => void): void {
  const criticSchema = path.join(packageRoot(), 'skills', 'plan-critic', 'critique.schema.json');
  const maxPlanLines = Number(process.env.PLAN_LOOP_MAX_PLAN_LINES ?? 900);
  const iters: number[] = [];
  for (const name of readdirSync(work)) {
    const match = /^critique\.v([0-9]+)\.json$/.exec(name);
    if (match) {
      iters.push(Number(match[1]));
    }
  }
  iters.sort((a, b) => a - b);
  if (iters.length === 0) {
    write(`    ${pal.DIM}(no iterations completed yet)${pal.R}\n`);
    return;
  }

  write(
    `    ${pal.B}${pad('iter', 5)} ${pad('raw', 5)} ${pad('addr/new/inv/%', 13)} ${pad('applied', 7)} ${pad('blk/maj', 8)} ${pad('rejct', 7)} ${pad('lines', 7)} flag${pal.R}\n`,
  );

  for (const iter of iters) {
    const critiqueFile = path.join(work, `critique.v${iter}.json`);
    const critique = readJsonObject(critiqueFile);
    const raw = critique && Array.isArray(critique.issues) ? String(critique.issues.length) : '?';
    let addr = '?';
    let neu = '?';
    let invalid = '?';
    let pct = '?';
    try {
      const health = critiqueHealth(work, criticSchema, iter, critiqueFile);
      addr = String(health.addressed);
      neu = String(health.newIssues);
      invalid = String(health.invalid);
      pct = String(health.pct);
    } catch {
      /* keep placeholders */
    }
    const update = readJsonObject(path.join(work, `update.v${iter}.json`));
    let applied = '—';
    let blk = '?';
    let maj = '?';
    let rej = '—';
    if (update !== undefined) {
      applied = Array.isArray(update.applied) ? String(update.applied.length) : '0';
      const issues = Array.isArray(update.issues) ? update.issues : [];
      const count = (severity: string) =>
        issues.filter(
          (issue) =>
            isJsonObject(issue) &&
            (issue.verdict === 'accept' || issue.verdict === 'downgrade') &&
            issue.final_severity === severity,
        ).length;
      blk = String(count('blocker'));
      maj = String(count('major'));
      rej = Array.isArray(update.rejected_append) ? String(update.rejected_append.length) : '0';
    }
    const nextPlan = path.join(work, `plan.v${iter + 1}.md`);
    const lines = existsSync(nextPlan) ? String(fileLineCount(nextPlan)) : '—';

    let flag = '';
    if (pct !== '?' && Number(pct) < 30 && iter >= 2) {
      flag += ` ${pal.YEL}⚠drift${pal.R}`;
    }
    if (lines !== '—' && Number(lines) > maxPlanLines) {
      flag += ` ${pal.YEL}⚠big${pal.R}`;
    }
    if (invalid !== '?' && invalid !== '0') {
      flag += ` ${pal.YEL}⚠invalid-ref${pal.R}`;
    }
    if (invalid === '0' && blk === '0' && maj === '0') {
      flag += ` ${pal.GRN}✓healthy${pal.R}`;
    }

    write(
      `    ${pad(String(iter), 5)} ${pad(raw, 5)} ${pad(`${addr}/${neu}/${invalid}/${pct}%`, 13)} ${pad(applied, 7)} ${pad(`${blk}/${maj}`, 8)} ${pad(rej, 7)} ${pad(lines, 7)} ${flag}\n`,
    );
  }
}

function countFiles(work: string, pattern: RegExp): number {
  try {
    return readdirSync(work).filter((name) => pattern.test(name)).length;
  } catch {
    return 0;
  }
}

interface InterventionStatusLine {
  total: string;
  active: string;
  migrated: string;
  latest: string;
}

function operatorInterventionsStatus(work: string): InterventionStatusLine {
  const file = path.join(work, 'operator-interventions.jsonl');
  if (!nonEmptyFile(file)) {
    return { total: '0', active: '0', migrated: '0', latest: '—' };
  }
  const parseJsonl = (target: string): JsonObject[] | undefined => {
    const entries: JsonObject[] = [];
    for (const line of readFileSync(target, 'utf8').split('\n')) {
      if (line.trim() === '') {
        continue;
      }
      try {
        const parsed = JSON.parse(line) as JsonValue;
        entries.push(isJsonObject(parsed) ? parsed : {});
      } catch {
        return undefined;
      }
    }
    return entries;
  };
  const entries = parseJsonl(file);
  if (entries === undefined) {
    return { total: 'invalid', active: 'invalid', migrated: 'invalid', latest: file };
  }
  const migrationsFile = path.join(work, 'operator-intervention-migrations.jsonl');
  const migrations = nonEmptyFile(migrationsFile) ? (parseJsonl(migrationsFile) ?? []) : [];
  const migrated = new Set(
    migrations
      .map((entry) => entry.intervention_id)
      .filter((value): value is string => typeof value === 'string'),
  );
  const items = entries.map((entry, index) => ({
    id: typeof entry.id === 'string' && entry.id !== '' ? entry.id : `I${index + 1}`,
    ts: typeof entry.ts === 'string' ? entry.ts : 'unknown-time',
    target: typeof entry.target === 'string' ? entry.target : 'all',
    message: typeof entry.message === 'string' ? entry.message : '',
  }));
  const done = items.filter((item) => migrated.has(item.id)).length;
  const last = items[items.length - 1];
  const msg = (last?.message ?? '').replace(/[\r\n\t]+/g, ' ').slice(0, 100);
  return {
    total: String(items.length),
    active: String(items.length - done),
    migrated: String(done),
    latest: `${last?.ts ?? 'unknown-time'} target=${last?.target ?? 'all'} ${msg}`,
  };
}

function printStatus(root: number, pal: Palette, write: (s: string) => void): void {
  const cmdline = commandOf(root);
  if (cmdline === '') {
    write(`${pal.RED}PID ${root} not alive${pal.R}\n`);
    return;
  }

  const elapsed = psField(root, 'etime');
  const itersMatch = /(--iters|--max-iters)[ =]?([0-9]+)/.exec(cmdline);
  const itersMax = itersMatch?.[2] ?? 'default';
  const input = extractInputPath(cmdline);
  const work = resolveWorkDir(root, input);
  const logPath = work !== undefined ? path.join(work, 'run.log') : '';
  const name = work !== undefined ? path.basename(work).replace(/^loop-/, '') : `pid-${root}`;

  write(`\n${pal.B}━━ ${name} ━━${pal.R}\n`);
  write(`  PID=${root}  elapsed=${elapsed}  iters_cap=${itersMax}\n`);
  write(`  WORK: ${work ?? 'unknown'}\n`);

  if (work === undefined || !existsSync(work)) {
    write(`  ${pal.RED}WORK dir missing${pal.R}\n`);
    return;
  }

  write('\n  active children:\n');
  printTreeChildren(root, logPath, pal, write);

  const plans = countFiles(work, /^plan\.v[0-9]+\.md$/);
  const critiques = countFiles(work, /^critique\.v[0-9]+\.json$/);
  const updates = countFiles(work, /^update\.v[0-9]+\.json$/);
  const final = existsSync(path.join(work, 'plan.final.md')) ? `${pal.GRN}✓${pal.R}` : '—';
  write(`\n  artifacts: plans=${plans} critiques=${critiques} updates=${updates} final=${final}\n`);
  const interventions = operatorInterventionsStatus(work);
  write(
    `  interventions: total=${interventions.total} active=${interventions.active} migrated=${interventions.migrated} latest=${interventions.latest}\n`,
  );

  if (!existsSync(logPath)) {
    write(`\n  ${pal.YEL}no run.log yet${pal.R}\n`);
    return;
  }

  write('\n  iterations:\n');
  printIterTable(work, pal, write);

  const logLines = strippedLogLines(logPath);
  const lastEvent = logLines[logLines.length - 1] ?? '';
  write(`\n  last event: ${pal.DIM}${lastEvent.replace(/^\[plan-loop\] /, '')}${pal.R}\n`);

  try {
    const mtime = Math.floor(statSync(logPath).mtimeMs / 1000);
    const age = Math.floor(Date.now() / 1000) - mtime;
    write(`  last output: ${age}s ago\n`);
  } catch {
    /* no mtime */
  }
  const recent = readFileSync(logPath, 'utf8').split('\n').slice(-25).join('\n');
  if (recent.includes('claude stream stalled:')) {
    write(`  ${pal.YEL}(watchdog terminated a recent claude call, see run.log)${pal.R}\n`);
  } else if (recent.includes('claude api retry')) {
    write(`  ${pal.YEL}(claude is retrying API calls, waiting not progressing)${pal.R}\n`);
  }

  if (existsSync(path.join(work, 'plan.final.md'))) {
    write(`  ${pal.GRN}✓ converged (plan.final.md present)${pal.R}\n`);
  }

  write(`\n  follow: tail -F ${logPath}\n`);
  write(`  intervene: plan-loop intervene --work ${work} --target all "message"\n`);
  const pgid = psField(root, 'pgid');
  if (pgid !== '') {
    write(`  stop:   kill -TERM -${pgid}${pal.DIM}   (whole process group)${pal.R}\n`);
  } else {
    write(`  stop:   kill -TERM ${root}\n`);
  }
}

function collectPlanLoopRoots(): number[] {
  const registry = registryPids(statusStateDirCandidates());
  const roots: number[] = [];
  const identities = new Set<string>();
  const consider = (pid: number) => {
    if (!isAlive(pid)) {
      return;
    }
    if (!commandIsPlanLoopRoot(pid)) {
      return;
    }
    const pgid = psField(pid, 'pgid');
    const identity = pgid !== '' ? `pgid:${pgid}` : `pid:${pid}`;
    if (identities.has(identity)) {
      return;
    }
    identities.add(identity);
    roots.push(pid);
  };
  for (const pid of registry) {
    consider(pid);
  }
  if ((process.env.PLAN_LOOP_STATUS_SCAN_PS ?? '1') !== '0') {
    const out = ps(['-axo', 'pid=,ppid=']);
    for (const line of out.split('\n')) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 2) {
        continue;
      }
      if (Number(parts[1]) === 1) {
        consider(Number(parts[0]));
      }
    }
  }
  return roots;
}

export function runStatusCli(
  args: readonly string[],
  out: (text: string) => void = (text) => process.stdout.write(text),
): number {
  const pal = palette();
  const write = out;

  if (args.length === 0) {
    const roots = collectPlanLoopRoots();
    if (roots.length === 0) {
      process.stderr.write('no plan-loop runs currently active\n');
      return 0;
    }
    write(`${pal.DIM}found ${roots.length} plan-loop run(s)${pal.R}\n`);
    for (const root of roots) {
      printStatus(root, pal, write);
    }
    return 0;
  }

  if (args[0] === '-h' || args[0] === '--help') {
    write(STATUS_USAGE);
    return 0;
  }

  const pid = Number(args[0]);
  if (!Number.isInteger(pid) || commandOf(pid) === '') {
    process.stderr.write(`PID ${args[0] ?? ''} not found\n`);
    throw new HaltError('pid not found', 2, true);
  }

  const root = findRootPlanLoop(pid);
  if (root === undefined) {
    process.stderr.write(`PID ${pid} is not part of a plan-loop tree\n`);
    throw new HaltError('not a plan-loop pid', 3, true);
  }

  printStatus(root, pal, write);
  return 0;
}
