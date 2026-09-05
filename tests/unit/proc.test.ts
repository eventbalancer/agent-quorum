import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { killTree, spawnDetached, waitForExit } from '../../src/runtime/exec.js';
import { isAlive } from '../../src/runtime/proc.js';

it('bounds a stalled ps lookup and kills a child that ignores SIGTERM', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'bounded-ps-'));
  const pidFile = path.join(root, 'ps.pid');
  writeFileSync(
    path.join(root, 'ps'),
    `#!${process.execPath}
const { writeFileSync } = require('node:fs');
process.on('SIGTERM', () => {});
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
setInterval(() => {}, 1000);
`,
    { mode: 0o755 },
  );
  const moduleUrl = new URL('../../src/runtime/proc.ts', import.meta.url).href;
  const child = spawnDetached(
    process.execPath,
    [
      '--import',
      import.meta.resolve('tsx'),
      '--input-type=module',
      '-e',
      `import { ps } from ${JSON.stringify(moduleUrl)};
const start = performance.now();
const output = ps(['-p', String(process.pid)]);
process.stdout.write(JSON.stringify({ output, durationMs: performance.now() - start }));
`,
    ],
    { env: { ...process.env, PATH: root }, stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let output = '';
  let errors = '';
  child.stdout?.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr?.on('data', (chunk: Buffer) => {
    errors += chunk.toString();
  });
  let watchdogFired = false;
  const watchdog = setTimeout(() => {
    watchdogFired = true;
    killTree(child, 'SIGKILL');
  }, 6000);
  try {
    expect(await waitForExit(child), errors).toBe(0);
    expect(watchdogFired).toBe(false);
    const result = JSON.parse(output) as { output: string; durationMs: number };
    expect(result.output).toBe('');
    expect(result.durationMs).toBeLessThan(4500);
    expect(isAlive(Number(readFileSync(pidFile, 'utf8')))).toBe(false);
  } finally {
    clearTimeout(watchdog);
    killTree(child, 'SIGKILL');
    await waitForExit(child);
    rmSync(root, { recursive: true, force: true });
  }
}, 10_000);
