const INFO_PREFIX = '\x1b[36m[plan-loop]\x1b[0m';
const ERROR_PREFIX = '\x1b[31m[plan-loop]\x1b[0m';

export function log(message: string): void {
  process.stderr.write(`${INFO_PREFIX} ${message}\n`);
}

export function err(message: string): void {
  process.stderr.write(`${ERROR_PREFIX} ${message}\n`);
}
