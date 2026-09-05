import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertFrozenVerificationPolicy } from '../../src/delivery/verification-policy.js';
import { deliveryMandate } from '../helpers/delivery.js';

const directories: string[] = [];
afterEach(() => {
  directories.splice(0).forEach((directory) => {
    rmSync(directory, { recursive: true, force: true });
  });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'verification-policy-'));
  directories.push(root);
  const worktree = path.join(root, 'candidate');
  mkdirSync(worktree);
  const pkg = {
    name: 'fixture',
    version: '1.0.0',
    scripts: {
      check: 'pnpm run build && pnpm run types:check',
      build: 'tsc',
      'types:check': 'tsc --noEmit',
      test: 'vitest run',
    },
    devDependencies: { typescript: '6.0.3', vitest: '4.1.8' },
    dependencies: { example: '1' },
  };
  for (const directory of [root, worktree]) {
    writeFileSync(path.join(directory, 'package.json'), JSON.stringify(pkg));
    writeFileSync(
      path.join(directory, 'vitest.config.ts'),
      'export default {test:{include:["tests/**"]}};',
    );
  }
  return { root, worktree, pkg, mandate: deliveryMandate(root) };
}

describe('frozen verification policy', () => {
  it('rejects candidate scripts that replace mandatory checks with successful no-ops', () => {
    const { worktree, mandate, pkg } = fixture();
    writeFileSync(
      path.join(worktree, 'package.json'),
      JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, check: 'echo success' } }),
    );
    expect(() => {
      assertFrozenVerificationPolicy(mandate, worktree);
    }).toThrow('frozen-verification-package-policy-changed');
  });

  it('rejects self-excluding test configuration and new lifecycle hooks', () => {
    const { worktree, mandate, pkg } = fixture();
    writeFileSync(path.join(worktree, 'vitest.config.ts'), 'export default {test:{include:[]}};');
    expect(() => {
      assertFrozenVerificationPolicy(mandate, worktree);
    }).toThrow('frozen-verification-file-policy-changed');
    writeFileSync(
      path.join(worktree, 'package.json'),
      JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, pretest: 'rewrite-policy' } }),
    );
    expect(() => {
      assertFrozenVerificationPolicy(mandate, worktree);
    }).toThrow('frozen-verification-package-policy-changed');
  });

  it.each(['prepare', 'postinstall', 'prepublish', 'prepublishOnly', 'prepack'])(
    'rejects new automatic publication through %s',
    (script) => {
      const { worktree, mandate, pkg } = fixture();
      writeFileSync(
        path.join(worktree, 'package.json'),
        JSON.stringify({ ...pkg, scripts: { ...pkg.scripts, [script]: 'npm publish' } }),
      );
      expect(() => {
        assertFrozenVerificationPolicy(mandate, worktree);
      }).toThrow('frozen-verification-package-policy-changed');
    },
  );

  it('allows product dependency and API changes while preserving gate tools', () => {
    const { worktree, mandate, pkg } = fixture();
    writeFileSync(
      path.join(worktree, 'package.json'),
      JSON.stringify({
        ...pkg,
        exports: { '.': './new-api.js' },
        dependencies: { example: '2' },
        scripts: { ...pkg.scripts, product: 'node src/new-api.js' },
      }),
    );
    expect(() => {
      assertFrozenVerificationPolicy(mandate, worktree);
    }).not.toThrow();
    writeFileSync(
      path.join(worktree, 'package.json'),
      JSON.stringify({ ...pkg, devDependencies: { ...pkg.devDependencies, vitest: '0.1.0' } }),
    );
    expect(() => {
      assertFrozenVerificationPolicy(mandate, worktree);
    }).toThrow('frozen-verification-package-policy-changed');
  });
});
