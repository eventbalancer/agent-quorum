import { HaltError } from '../runtime/halt.js';
import { resolveArtifactRoots } from '../runtime/paths.js';
import { resolveConfig, type CliSettings, type ResolvedConfig } from '../core/config.js';
import { CONFIG_USAGE } from './help.js';

function usageError(message: string): never {
  process.stderr.write(`${message}\n`);
  throw new HaltError(message, 2, true);
}

function parseConfigArgs(args: readonly string[]): CliSettings {
  const cli: CliSettings = {};
  let i = 0;
  while (i < args.length) {
    const arg = args[i] ?? '';
    switch (true) {
      case arg === '--iters' || arg === '--max-iters': {
        const value = args[i + 1] ?? '';
        if (value === '') {
          usageError(`${arg} needs a value`);
        }
        cli.maxIters = value;
        i += 2;
        break;
      }
      case arg.startsWith('--iters=') || arg.startsWith('--max-iters='):
        cli.maxIters = arg.slice(arg.indexOf('=') + 1);
        i += 1;
        break;
      case arg === '--effort': {
        const value = args[i + 1] ?? '';
        if (value === '') {
          usageError('--effort needs a value');
        }
        cli.effort = value;
        i += 2;
        break;
      }
      case arg.startsWith('--effort='):
        cli.effort = arg.slice('--effort='.length);
        i += 1;
        break;
      case arg === '--locale': {
        const value = args[i + 1] ?? '';
        if (value === '') {
          usageError('--locale needs a value');
        }
        cli.locale = value;
        i += 2;
        break;
      }
      case arg.startsWith('--locale='):
        cli.locale = arg.slice('--locale='.length);
        i += 1;
        break;
      case arg === '--fix':
        cli.fix = '1';
        i += 1;
        break;
      case arg === '--no-fix':
        cli.fix = '0';
        i += 1;
        break;
      case arg === '--translate':
        cli.translate = '1';
        i += 1;
        break;
      case arg === '--no-translate':
        cli.translate = '0';
        i += 1;
        break;
      default:
        usageError(`unknown flag: ${arg}`);
    }
  }
  return cli;
}

// Never echo the resolved bot token: replace it with a fixed mask before printing.
function maskToken(config: ResolvedConfig): ResolvedConfig {
  return {
    ...config,
    telegram: { ...config.telegram, botToken: config.telegram.botToken === '' ? '' : '***' },
  };
}

export function runConfigShowCli(
  args: readonly string[],
  out: (text: string) => void = (text) => {
    process.stdout.write(text);
  },
): number {
  if (args.includes('-h') || args.includes('--help')) {
    out(CONFIG_USAGE);
    return 0;
  }
  const cli = parseConfigArgs(args);
  const { home } = resolveArtifactRoots();
  const { config, provenance } = resolveConfig({ overrides: { cli }, env: process.env, home });
  out(`resolved configuration (home: ${home})\n`);
  out(`${JSON.stringify(maskToken(config), null, 2)}\n`);
  out('\nwinning layer per setting (override > env > store > default):\n');
  for (const key of [...provenance.keys()].sort()) {
    out(`  ${key}: ${provenance.get(key) ?? 'default'}\n`);
  }
  return 0;
}
