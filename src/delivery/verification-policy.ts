import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { canonicalConfiguration } from './config-attestation.js';
import { contentDigest, DeliveryError, digest, type Mandate } from './contract.js';

import { VERIFICATION_POLICY_FILES } from './gate-toolchain.js';
export { VERIFICATION_POLICY_FILES } from './gate-toolchain.js';

const SCRIPTS = [
  'check',
  'build',
  'build:clean',
  'types:check',
  'lint:check',
  'lint:fix',
  'format:check',
  'format:write',
  'test',
  'test:coverage',
  'install',
  'prepare',
  'pack',
  'publish',
  'prepublishOnly',
];
const TOOL_DEPENDENCIES =
  /^(?:@eslint\/|@types\/node$|@vitest\/|eslint(?:$|-)|jiti$|prettier(?:$|-)|tsx$|typescript(?:$|-)|vitest$)/u;

function packageObject(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new DeliveryError('verification-policy-package-invalid');
  }
  return value as Record<string, unknown>;
}

function packagePolicy(root: string): unknown {
  const value = packageObject(
    JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as unknown,
  );
  const scripts = packageObject(value.scripts ?? {});
  const devDependencies = packageObject(value.devDependencies ?? {});
  const dependencies = packageObject(value.dependencies ?? {});
  return canonicalConfiguration({
    scripts: Object.fromEntries(
      SCRIPTS.flatMap((script) => [script, `pre${script}`, `post${script}`]).map((script) => [
        script,
        scripts[script] ?? null,
      ]),
    ),
    tools: Object.fromEntries(
      Object.entries(devDependencies).filter(([name]) => TOOL_DEPENDENCIES.test(name)),
    ),
    productionTools: Object.fromEntries(
      Object.entries(dependencies).filter(([name]) => TOOL_DEPENDENCIES.test(name)),
    ),
    packageManager: value.packageManager ?? null,
    pnpm: value.pnpm ?? null,
    prettier: value.prettier ?? null,
    eslintConfig: value.eslintConfig ?? null,
  });
}

function filePolicy(root: string, relative: string): string | null {
  const file = path.join(root, relative);
  const metadata = lstatSync(file, { throwIfNoEntry: false });
  if (metadata === undefined) {
    return null;
  }
  if (!metadata.isFile()) {
    throw new DeliveryError('verification-policy-must-be-regular-file');
  }
  return contentDigest(readFileSync(file));
}

export function assertFrozenVerificationPolicy(mandate: Mandate, worktree: string): void {
  if (digest(packagePolicy(mandate.runtimeRoot)) !== digest(packagePolicy(worktree))) {
    throw new DeliveryError('frozen-verification-package-policy-changed');
  }
  for (const relative of VERIFICATION_POLICY_FILES) {
    if (filePolicy(mandate.runtimeRoot, relative) !== filePolicy(worktree, relative)) {
      throw new DeliveryError('frozen-verification-file-policy-changed');
    }
  }
}
