import { appendFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { HaltError } from '../runtime/halt.js';
import { resolveArtifactRoots } from '../runtime/paths.js';
import { nowUtcStamp } from '../core/artifacts.js';
import { INTERVENE_USAGE } from './help.js';
import { parseSelector, resolveSelector, type Selector } from './select.js';

function interveneSelector(
  idValue: string | undefined,
  nameValue: string | undefined,
  last: boolean,
  messageParts: string[],
): Selector | undefined {
  if (idValue !== undefined) {
    return { kind: 'id', value: idValue };
  }
  if (nameValue !== undefined) {
    return { kind: 'name', value: nameValue };
  }
  if (last) {
    return { kind: 'last' };
  }
  if (messageParts.length === 0) {
    return undefined;
  }
  const selector = parseSelector(messageParts[0]);
  messageParts.shift();
  return selector;
}

function usage(): never {
  process.stderr.write(INTERVENE_USAGE);
  throw new HaltError('usage', 1, true);
}

export function runInterveneCli(
  args: readonly string[],
  out: (text: string) => void = (text) => process.stdout.write(text),
): number {
  let work = '';
  let target = 'all';
  let readStdin = false;
  let last = false;
  let idValue: string | undefined;
  let nameValue: string | undefined;
  const messageParts: string[] = [];

  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    switch (true) {
      case arg === '--last':
        last = true;
        i += 1;
        break;
      case arg === '--id': {
        idValue = args[i + 1] ?? '';
        if (idValue === '') {
          usage();
        }
        i += 2;
        break;
      }
      case arg.startsWith('--id='):
        idValue = arg.slice('--id='.length);
        i += 1;
        break;
      case arg === '--name': {
        nameValue = args[i + 1] ?? '';
        if (nameValue === '') {
          usage();
        }
        i += 2;
        break;
      }
      case arg.startsWith('--name='):
        nameValue = arg.slice('--name='.length);
        i += 1;
        break;
      case arg === '--work': {
        work = args[i + 1] ?? '';
        if (work === '') {
          usage();
        }
        i += 2;
        break;
      }
      case arg.startsWith('--work='):
        work = arg.slice('--work='.length);
        i += 1;
        break;
      case arg === '--target': {
        target = args[i + 1] ?? '';
        if (target === '') {
          usage();
        }
        i += 2;
        break;
      }
      case arg.startsWith('--target='):
        target = arg.slice('--target='.length);
        i += 1;
        break;
      case arg === '--stdin':
        readStdin = true;
        i += 1;
        break;
      case arg === '-h' || arg === '--help':
        out(INTERVENE_USAGE);
        return 0;
      case arg === '--':
        i += 1;
        while (i < args.length) {
          messageParts.push(args[i] ?? '');
          i += 1;
        }
        break;
      case arg.startsWith('-'):
        process.stderr.write(`unknown flag: ${arg}\n`);
        usage();
        break;
      default:
        messageParts.push(arg);
        i += 1;
        break;
    }
  }

  if (work === '') {
    const selector = interveneSelector(idValue, nameValue, last, messageParts);
    if (selector === undefined) {
      usage();
    }
    const resolved = resolveSelector(selector, { stateDir: resolveArtifactRoots().stateDir });
    if (resolved === undefined) {
      process.stderr.write('no run matches selector\n');
      return 2;
    }
    work = resolved.workDir;
  }
  if (!['all', 'creator', 'critic', 'fixer', 'reviewer'].includes(target)) {
    process.stderr.write(`invalid target: ${target}\n`);
    usage();
  }

  if (!path.isAbsolute(work)) {
    work = path.join(process.cwd(), work);
  }
  if (!existsSync(work) || !statSync(work).isDirectory()) {
    process.stderr.write(`workdir not found: ${work}\n`);
    return 2;
  }

  let message: string;
  if (readStdin) {
    message = readFileSync(0, 'utf8');
  } else {
    if (messageParts.length === 0) {
      usage();
    }
    message = messageParts.join(' ');
  }
  if (message === '') {
    process.stderr.write('empty intervention\n');
    return 2;
  }

  const file = path.join(work, 'operator-interventions.jsonl');
  const id = `op-${randomUUID()}`;
  appendFileSync(file, `${JSON.stringify({ id, ts: nowUtcStamp(), target, message })}\n`);
  out(`recorded intervention: ${file} id=${id} target=${target}\n`);
  return 0;
}
