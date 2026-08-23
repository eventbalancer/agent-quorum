export type HaltDiagnosticCode =
  | 'config-override-invalid'
  | 'secrets-handoff-invalid'
  | 'halt-error';

export class HaltError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly logged = false,
    readonly diagnosticCode: HaltDiagnosticCode = 'halt-error',
  ) {
    super(message);
    this.name = 'HaltError';
  }
}

export function haltDiagnostic(error: HaltError): string {
  return `agent-quorum: halted (code=${error.diagnosticCode} exit=${String(error.exitCode)})`;
}
