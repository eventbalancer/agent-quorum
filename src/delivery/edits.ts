import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { contentDigest, DeliveryError, digest } from './contract.js';
import type { DeliveryLedger } from './ledger.js';

export interface ExactHunk {
  readonly before: string;
  readonly after: string;
}

export interface DeliveryEdit {
  readonly kind: 'patch' | 'create' | 'delete';
  readonly path: string;
  readonly baseSha256: string | null;
  readonly mode: number;
  readonly hunks: readonly ExactHunk[];
  readonly content: string | null;
}

interface RecordedEditBatch {
  readonly root: string;
  readonly prepared: PreparedEdit[];
}

interface PreparedEdit {
  readonly path: string;
  readonly before: string | null;
  readonly after: string | null;
  readonly mode: number;
}

const MAX_BATCH_BYTES = 2 * 1024 * 1024;
const FORBIDDEN_PATHS =
  /^(?:\.git(?:\/|$)|\.env(?:\.|$)|\.codex(?:\/|$)|\.npmrc$|\.pnpmfile\.|node_modules(?:\/|$)|dist(?:\/|$)|coverage(?:\/|$)|pnpm-lock\.yaml$|\.agents\/(?:plans|requirements|prompts|execution-journals)(?:\/|$))/;

export function ownedPath(root: string, relative: string): string {
  const segments = relative.split('/');
  const isUnsafe =
    relative === '' ||
    path.isAbsolute(relative) ||
    relative.includes('\\') ||
    segments.some(
      (segment) =>
        segment === '' ||
        segment === '.' ||
        segment === '..' ||
        segment === '.git' ||
        segment === '.codex',
    ) ||
    FORBIDDEN_PATHS.test(relative);
  if (isUnsafe) {
    throw new DeliveryError('edit-path-outside-owned-scope');
  }
  let resolved = root;
  for (const segment of segments) {
    resolved = path.join(resolved, segment);
    const metadata = lstatSync(resolved, { throwIfNoEntry: false });
    if (metadata?.isSymbolicLink() === true) {
      throw new DeliveryError('edit-symlink-requires-canonical-target');
    }
  }
  return resolved;
}

function packageVersion(text: string): unknown {
  const value: unknown = JSON.parse(text);
  if (typeof value !== 'object' || value === null || !('version' in value)) {
    return undefined;
  }
  return value.version;
}

export function assertNoReleaseEdit(
  relative: string,
  before: string | null,
  after: string | null,
): void {
  if (
    relative === 'package.json' &&
    (before === null || after === null || packageVersion(before) !== packageVersion(after))
  ) {
    throw new DeliveryError('release-version-edit-excluded');
  }
  if (relative.startsWith('.github/workflows/')) {
    throw new DeliveryError('release-workflow-edit-excluded');
  }
}

function applyHunks(before: string, hunks: readonly ExactHunk[]): string {
  let content = before;
  for (const hunk of hunks) {
    const position = content.indexOf(hunk.before);
    if (hunk.before === '' || position < 0 || content.includes(hunk.before, position + 1)) {
      throw new DeliveryError('edit-hunk-not-unique');
    }
    content =
      content.slice(0, position) + hunk.after + content.slice(position + hunk.before.length);
  }
  return content;
}

function prepareEdit(root: string, edit: DeliveryEdit): PreparedEdit {
  const target = ownedPath(root, edit.path);
  if (edit.mode !== 0o644 && edit.mode !== 0o755) {
    throw new DeliveryError('unsupported-edit-mode');
  }
  const before = existsSync(target) ? readFileSync(target, 'utf8') : null;
  const baseDigest = before === null ? null : contentDigest(before);
  if (baseDigest !== edit.baseSha256) {
    throw new DeliveryError('edit-base-digest-mismatch');
  }
  if (edit.kind === 'create' && (before !== null || edit.content === null)) {
    throw new DeliveryError('invalid-create-edit');
  }
  if (edit.kind !== 'create' && before === null) {
    throw new DeliveryError('edit-target-missing');
  }
  let after: string | null;
  switch (edit.kind) {
    case 'create':
      after = edit.content;
      break;
    case 'delete':
      after = null;
      break;
    case 'patch':
      after = applyHunks(before ?? '', edit.hunks);
      break;
  }
  assertNoReleaseEdit(edit.path, before, after);
  return { path: edit.path, before, after, mode: edit.mode };
}

export class EditBroker {
  constructor(private readonly ledger: DeliveryLedger) {}

  apply(
    issue: number,
    root: string,
    edits: readonly DeliveryEdit[],
    batchIdentity = digest(edits),
    afterFile?: (index: number) => void,
  ): void {
    this.ledger.assertAuthorized('edit', issue);
    const key = `edit:${issue}:${batchIdentity}`;
    const prior = this.ledger.effect(key);
    if (prior?.state === 'completed') {
      return;
    }
    let prepared: PreparedEdit[];
    if (prior !== undefined) {
      const recorded = prior.input as RecordedEditBatch;
      if (recorded.root !== root) {
        throw new DeliveryError('edit-owner-root-mismatch', true);
      }
      prepared = recorded.prepared;
    } else {
      if (new Set(edits.map((edit) => edit.path)).size !== edits.length) {
        throw new DeliveryError('duplicate-edit-path');
      }
      if (Buffer.byteLength(JSON.stringify(edits)) > MAX_BATCH_BYTES) {
        throw new DeliveryError('edit-batch-too-large');
      }
      prepared = edits.map((edit) => prepareEdit(root, edit));
      this.ledger.intendEffect({
        key,
        kind: 'edit',
        issue,
        state: 'intended',
        input: { root, prepared },
      });
    }
    for (const [index, edit] of prepared.entries()) {
      this.ledger.assertAuthorized('edit', issue);
      const target = ownedPath(root, edit.path);
      const current = existsSync(target) ? readFileSync(target, 'utf8') : null;
      if (current !== edit.before && current !== edit.after) {
        throw new DeliveryError('interrupted-edit-conflicts-with-current-file');
      }
      if (current !== edit.after) {
        if (edit.after === null) {
          unlinkSync(target);
        } else {
          mkdirSync(path.dirname(target), { recursive: true });
          const staged = `${target}.delivery-${batchIdentity.slice(0, 12)}`;
          const stagedMetadata = lstatSync(staged, { throwIfNoEntry: false });
          if (stagedMetadata !== undefined) {
            if (stagedMetadata.isSymbolicLink() || readFileSync(staged, 'utf8') !== edit.after) {
              throw new DeliveryError('edit-staging-conflict');
            }
          } else {
            writeFileSync(staged, edit.after, { flag: 'wx', mode: edit.mode });
          }
          renameSync(staged, target);
        }
      }
      if (edit.after !== null) {
        chmodSync(target, edit.mode);
      }
      afterFile?.(index);
    }
    this.ledger.finishEffect(
      key,
      'completed',
      prepared.map((edit) => ({
        path: edit.path,
        sha256: edit.after === null ? null : contentDigest(edit.after),
        mode: edit.mode,
      })),
    );
  }
}
