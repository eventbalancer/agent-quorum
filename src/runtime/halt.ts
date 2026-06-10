export class HaltError extends Error {
  constructor(
    message: string,
    readonly exitCode: number,
    readonly logged = false,
  ) {
    super(message);
    this.name = 'HaltError';
  }
}
