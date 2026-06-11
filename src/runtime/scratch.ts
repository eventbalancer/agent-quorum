import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export class Scratch {
  private constructor(readonly dir: string) {}

  static create(base: string): Scratch {
    return new Scratch(mkdtempSync(path.join(os.tmpdir(), `plan-loop-${base}.`)));
  }

  file(): string {
    for (;;) {
      const candidate = path.join(this.dir, `tmp.${randomBytes(4).toString('hex')}`);
      try {
        writeFileSync(candidate, '', { flag: 'wx' });
        return candidate;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          throw error;
        }
      }
    }
  }

  sweep(): void {
    rmSync(this.dir, { recursive: true, force: true });
  }
}
