import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { nonEmptyFile } from '../runtime/files.js';

export interface SessionArgs {
  args: string[];
  wasResume: boolean;
}

function ensureSessionId(file: string): string {
  if (!nonEmptyFile(file)) {
    writeFileSync(file, `${randomUUID()}\n`);
  }
  return readFileSync(file, 'utf8').trim();
}

// Empty sessionFile means stateless: no --session-id/--resume. Only
// (creator, claude) and (creator, cursor) under SESSION_MODE pass a file.
export function claudeSessionArgs(sessionFile: string): SessionArgs {
  if (sessionFile === '') return { args: [], wasResume: false };
  if (nonEmptyFile(sessionFile)) {
    return { args: ['--resume', readFileSync(sessionFile, 'utf8').trim()], wasResume: true };
  }
  return { args: ['--session-id', ensureSessionId(sessionFile)], wasResume: false };
}

// Cursor assigns session_id on the first result event; until captured there is
// no session arg at all.
export function cursorSessionArgs(sessionFile: string): SessionArgs {
  if (sessionFile === '') return { args: [], wasResume: false };
  if (nonEmptyFile(sessionFile)) {
    return { args: ['--resume', readFileSync(sessionFile, 'utf8').trim()], wasResume: true };
  }
  return { args: [], wasResume: false };
}
