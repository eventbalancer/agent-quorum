#!/usr/bin/env node
import { HaltError } from '../runtime/halt.js';
import { globalHelp, packageVersion } from './help.js';
import { runInterveneCli } from './intervene.js';
import { runLaunchCli } from './launch.js';
import { runPlanLoopCli } from './run.js';
import { runStatusCli } from './status.js';

process.title = 'plan-loop';

// Finding F12: the four reference scripts map 1:1 onto one bin. A first
// argument of exactly launch/status/intervene routes to that entry point;
// anything else (including any file path) is the core run.
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const first = args[0];
  if (first === '--version' || first === '-V') {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  if (first === '--help' || first === '-h') {
    process.stdout.write(globalHelp());
    return 0;
  }
  switch (first) {
    case 'launch':
      return (await runLaunchCli(args.slice(1))).exitCode;
    case 'status':
      return runStatusCli(args.slice(1));
    case 'intervene':
      return runInterveneCli(args.slice(1));
    default:
      return (await runPlanLoopCli(args)).exitCode;
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof HaltError) {
      if (!error.logged) {
        process.stderr.write(`${error.message}\n`);
      }
      process.exitCode = error.exitCode;
      return;
    }
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
