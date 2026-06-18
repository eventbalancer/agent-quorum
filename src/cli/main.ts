#!/usr/bin/env node
import { HaltError } from '../runtime/halt.js';
import { findStage, stages } from '../stages/registry.js';
import { globalHelp, packageVersion, type StageSummary } from './help.js';
import { runConfigShowCli } from './config-show.js';
import { runSetupCli } from './setup.js';
import { runInterveneCli } from './intervene.js';
import { runLaunchCli } from './launch.js';
import { runLogsCli, runPruneCli, runShowCli } from './runs.js';
import { openShellOrHelp, runShell } from './shell/index.js';
import { runStatusCliInteractive } from './status.js';

process.title = 'agent-quorum';

// Umbrella dispatcher: reserved run-lifecycle commands plus a stage registry
// (`plan` is the sole entry today). No default fallthrough — an unrecognized
// first token is an error. A leading `--` is dropped twice: at the front for the
// `pnpm run dev -- <command>` forwarding case, and again after the subcommand for
// the `pnpm run plan:self -- --prompt …` case, so the stage parser sees its
// own flags intact.
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  if (args[0] === '--') {
    args.shift();
  }
  const summaries: readonly StageSummary[] = stages.map((stage) => ({
    name: stage.name,
    summary: stage.summary,
  }));
  const first = args[0];
  if (first === undefined) {
    return await openShellOrHelp(
      { input: process.stdin, output: process.stdout },
      { runShell, writeHelp: () => process.stdout.write(globalHelp(summaries)) },
    );
  }
  if (first === '--help' || first === '-h') {
    process.stdout.write(globalHelp(summaries));
    return 0;
  }
  if (first === '--version' || first === '-V') {
    process.stdout.write(`${packageVersion()}\n`);
    return 0;
  }
  const rest = args.slice(1);
  if (rest[0] === '--') {
    rest.shift();
  }
  switch (first) {
    case 'launch':
      return (await runLaunchCli(rest)).exitCode;
    case 'status':
      return runStatusCliInteractive(rest);
    case 'show':
      return runShowCli(rest);
    case 'logs':
      return await runLogsCli(rest);
    case 'prune':
      return runPruneCli(rest);
    case 'intervene':
      return runInterveneCli(rest);
    case 'setup':
      return await runSetupCli(rest);
    case 'config':
      return runConfigShowCli(rest);
    default: {
      const stage = findStage(first);
      if (stage !== undefined) {
        return await stage.run(rest);
      }
      process.stderr.write(`agent-quorum: unknown command '${first}'\n\n`);
      process.stderr.write(globalHelp(summaries));
      return 2;
    }
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
