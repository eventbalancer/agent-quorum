export const PROVIDER_FRAME_PREFIX = '@agent-quorum/provider ';
export const PROVIDER_MESSAGE_BYTES = 4 * 1024 * 1024;
export type ProviderRequestHandler = (request: unknown, signal: AbortSignal) => Promise<unknown>;

interface ProviderChannel {
  consume(line: string): boolean;
  close(): Promise<void>;
}

export function providerChannel(
  handle: ProviderRequestHandler,
  send: (value: unknown) => void,
): ProviderChannel {
  const active = new Map<string, AbortController>();
  const tasks = new Set<Promise<void>>();
  let closed = false;
  return {
    consume(line) {
      if (!line.startsWith(PROVIDER_FRAME_PREFIX)) {
        return false;
      }
      try {
        if (Buffer.byteLength(line) > PROVIDER_MESSAGE_BYTES) {
          return true;
        }
        const value: unknown = JSON.parse(line.slice(PROVIDER_FRAME_PREFIX.length));
        if (
          typeof value !== 'object' ||
          value === null ||
          !('id' in value) ||
          typeof value.id !== 'string' ||
          !/^[a-f0-9-]{36}$/.test(value.id)
        ) {
          return true;
        }
        const id = value.id;
        if ('cancel' in value && value.cancel === true) {
          active.get(id)?.abort();
          return true;
        }
        if (closed || active.has(id) || active.size >= 16 || !('request' in value)) {
          send({ type: 'provider-response', id, response: { status: 1, output: '' } });
          return true;
        }
        const abort = new AbortController();
        active.set(id, abort);
        const task = Promise.resolve()
          .then(() => handle(value.request, abort.signal))
          .then((response) => {
            if (!closed) {
              const bounded =
                Buffer.byteLength(JSON.stringify(response)) <= PROVIDER_MESSAGE_BYTES
                  ? response
                  : { status: 1, output: '' };
              send({ type: 'provider-response', id, response: bounded });
            }
          })
          .catch(() => {
            if (!closed) {
              send({ type: 'provider-response', id, response: { status: 1, output: '' } });
            }
          })
          .finally(() => {
            active.delete(id);
          });
        tasks.add(task);
        void task.finally(() => {
          tasks.delete(task);
        });
      } catch {
        return true;
      }
      return true;
    },
    async close() {
      closed = true;
      for (const abort of active.values()) {
        abort.abort();
      }
      await Promise.allSettled(tasks);
    },
  };
}
