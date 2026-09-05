import { registerHooks } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

const toolchain = process.env.AGENT_QUORUM_GATE_TOOLCHAIN;
if (typeof toolchain !== 'string' || !path.isAbsolute(toolchain)) {
  throw new Error('frozen gate toolchain is required');
}
const trustedPrefix = pathToFileURL(toolchain + path.sep).href;
const parentURL = pathToFileURL(path.join(toolchain, 'package.json')).href;
const tool =
  /^(?:vitest(?:\/|$)|@vitest\/|vite(?:\/|$)|vite-node(?:\/|$)|tsx(?:\/|$)|typescript(?:\/|$)|typescript-eslint(?:\/|$)|@typescript-eslint\/|eslint(?:\/|$)|@eslint\/|eslint-config-prettier(?:\/|$)|prettier(?:\/|$)|jiti(?:\/|$))/;
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(
      specifier,
      tool.test(specifier) && !context.parentURL?.startsWith(trustedPrefix)
        ? { ...context, parentURL }
        : context,
    );
  },
});
