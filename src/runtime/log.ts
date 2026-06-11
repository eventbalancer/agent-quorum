export interface ColorStream {
  isTTY?: boolean;
}

// Computed per call (never cached at import time) so a NO_COLOR/isTTY change
// after module load takes effect. NO_COLOR follows no-color.org: present and
// non-empty disables color regardless of its value.
export function colorsEnabled(stream: ColorStream = process.stderr): boolean {
  const noColor = process.env.NO_COLOR;
  if (noColor !== undefined && noColor !== '') {
    return false;
  }
  return stream.isTTY === true;
}

function prefix(colorCode: string): string {
  return colorsEnabled() ? `${colorCode}[plan-loop]\x1b[0m` : '[plan-loop]';
}

export function log(message: string): void {
  process.stderr.write(`${prefix('\x1b[36m')} ${message}\n`);
}

export function err(message: string): void {
  process.stderr.write(`${prefix('\x1b[31m')} ${message}\n`);
}
