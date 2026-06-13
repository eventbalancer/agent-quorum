/**
 * Minimal example: drive the plan -> critique -> update loop through the public
 * agent-quorum API, then read the run back from the durable ledger.
 *
 *   pnpm run build
 *   pnpm exec tsx examples/api.ts examples/task.example.md
 *
 * To write artifacts into this repo's dogfood ledger (under .agents/plans/)
 * instead of the user-home default, prefix the artifact root:
 *
 *   AGENT_QUORUM_PLANS_DIR=.agents/plans pnpm exec tsx examples/api.ts examples/task.example.md
 *
 * Running it launches a real loop and needs an authenticated provider CLI.
 */
import process from 'node:process';
import { ExitCode, getRunStatus, listRuns, runPlanLoop } from 'agent-quorum';

async function main(): Promise<number> {
  const input = process.argv[2];
  if (input === undefined) {
    process.stderr.write('usage: tsx examples/api.ts <task-prompt.md>\n');
    return 1;
  }

  // The API returns a structured result and never calls process.exit.
  const result = await runPlanLoop({
    input,
    prompt: true, // treat the input as a task prompt, not an existing plan
    effort: 'high',
    iters: 3,
  });

  if (result.exitCode !== 0) {
    process.stderr.write(`run failed with exit code ${result.exitCode}\n`);
    return result.exitCode;
  }

  process.stdout.write(
    [
      `converged in ${result.iterations} iteration(s)`,
      `final plan: ${result.finalPlanPath}`,
      `summary:    ${result.summaryPath}`,
    ].join('\n') + '\n',
  );

  if (result.health !== undefined) {
    const { addressed, critic, validAddressedPct } = result.health;
    process.stdout.write(
      `health: ${addressed}/${critic} addressed (${validAddressedPct}% valid)\n`,
    );
  }

  // The same run is now addressable in the durable ledger.
  process.stdout.write(`ledger holds ${listRuns().length} run record(s)\n`);

  // A status snapshot of every currently running loop (none, once this returns).
  process.stdout.write(getRunStatus().output);

  return ExitCode.Ok;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
