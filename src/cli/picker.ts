import { createInterface } from 'node:readline';
import {
  compareRunsByRecency,
  readRunRecords,
  resolveRunState,
  retentionKeepCount,
  type RunRecord,
  type RunState,
} from '../core/run-store.js';
import { resolveArtifactRoots } from '../runtime/paths.js';
import { systemProbes } from './probes.js';

export interface RunCandidate {
  readonly record: RunRecord;
  readonly state: RunState;
  readonly isLive: boolean;
}

export interface RenderListingOptions {
  readonly color: boolean;
}

export interface PickStreams {
  readonly input: NodeJS.ReadableStream & { isTTY?: boolean };
  readonly output: NodeJS.WritableStream & { isTTY?: boolean };
}

const SHORT_RUN_ID_LENGTH = 12;

// Live runs first (most recent), then recent finished runs bounded by the same
// retention count prune enforces, so the listing never exceeds what is kept.
export function listCandidates(): RunCandidate[] {
  const records = readRunRecords(resolveArtifactRoots().stateDir);
  const live: RunCandidate[] = [];
  const finished: RunCandidate[] = [];
  for (const record of records) {
    const state = resolveRunState(record, systemProbes);
    if (state === 'running') {
      live.push({ record, state, isLive: true });
    } else {
      finished.push({ record, state, isLive: false });
    }
  }
  live.sort((a, b) => compareRunsByRecency(a.record, b.record));
  finished.sort((a, b) => compareRunsByRecency(a.record, b.record));
  return [...live, ...finished.slice(0, retentionKeepCount())];
}

function dim(text: string, color: boolean): string {
  return color ? `\x1b[2m${text}\x1b[0m` : text;
}

function shortRunId(runId: string): string {
  return runId.length > SHORT_RUN_ID_LENGTH ? runId.slice(0, SHORT_RUN_ID_LENGTH) : runId;
}

function timeField(candidate: RunCandidate): string {
  if (candidate.isLive) {
    return `started ${candidate.record.startedAt}`;
  }
  return `ended ${candidate.record.endedAt ?? candidate.record.startedAt}`;
}

function formatLine(candidate: RunCandidate, index: number, color: boolean): string {
  const record = candidate.record;
  const meta = dim(`${shortRunId(record.runId)}  ${timeField(candidate)}`, color);
  return `  ${index}) ${record.name}  [${candidate.state}]  ${meta}  ${record.workDir}`;
}

export function renderListing(
  candidates: readonly RunCandidate[],
  options: RenderListingOptions,
): string {
  const lines = [dim(`found ${candidates.length} agent-quorum run(s)`, options.color)];
  for (const [index, candidate] of candidates.entries()) {
    lines.push(formatLine(candidate, index + 1, options.color));
  }
  return `${lines.join('\n')}\n`;
}

// A single candidate auto-selects without prompting. Otherwise read one numbered
// choice via readline on the injected streams. An out-of-range or blank reply
// resolves to undefined (no selection). Callers gate this on both streams being
// TTYs so a non-interactive context never reaches here.
export async function pickInteractive(
  candidates: readonly RunCandidate[],
  streams: PickStreams,
): Promise<RunCandidate | undefined> {
  if (candidates.length === 0) {
    return undefined;
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  streams.output.write(renderListing(candidates, { color: streams.output.isTTY === true }));
  const rl = createInterface({ input: streams.input, output: streams.output });
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`select a run [1-${candidates.length}]: `, resolve);
    });
    const index = Number(answer.trim());
    if (!Number.isInteger(index) || index < 1 || index > candidates.length) {
      return undefined;
    }
    return candidates[index - 1];
  } finally {
    rl.close();
  }
}
