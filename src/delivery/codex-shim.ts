import { readFileSync, writeFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDER_MESSAGE_BYTES } from './provider-channel.js';

export interface CodexProxyCall {
  readonly model: string;
  readonly reasoning: string;
  readonly prompt: string;
  readonly schema: unknown;
}

interface CodexProxyArguments {
  readonly call: CodexProxyCall;
  readonly outputFile: string;
}

export function parseCodexProxyArgs(args: readonly string[]): CodexProxyArguments {
  if (args[0] !== 'exec') {
    throw new Error('unsupported confined Codex command');
  }
  let model: string | undefined;
  let reasoning = '';
  let schemaFile: string | undefined;
  let outputFile: string | undefined;
  let prompt: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--skip-git-repo-check' || flag === '--json' || flag === '--ignore-user-config') {
      continue;
    }
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error('incomplete confined Codex command');
    }
    index += 1;
    if (flag === '-m' || flag === '--model') {
      model = value;
    } else if (flag === '--output-schema') {
      schemaFile = value;
    } else if (flag === '-o' || flag === '--output-last-message') {
      outputFile = value;
    } else if (flag === '-c' || flag === '--config') {
      const match = /^model_reasoning_effort="([a-z]+)"$/.exec(value);
      if (match?.[1] === undefined) {
        throw new Error('confined Codex cannot change configuration');
      }
      reasoning = match[1];
    } else if (
      (flag === '--sandbox' && value === 'read-only') ||
      (flag === '--color' && value === 'never')
    ) {
      continue;
    } else if (flag === '--' && index === args.length - 1) {
      prompt = value;
    } else {
      throw new Error('unsupported confined Codex argument');
    }
  }
  if (
    model === undefined ||
    schemaFile === undefined ||
    outputFile === undefined ||
    prompt === undefined ||
    Buffer.byteLength(prompt) > PROVIDER_MESSAGE_BYTES / 2
  ) {
    throw new Error('invalid confined Codex request');
  }
  const schemaText = readFileSync(schemaFile, 'utf8');
  if (Buffer.byteLength(schemaText) > PROVIDER_MESSAGE_BYTES / 2) {
    throw new Error('confined Codex schema is too large');
  }
  return {
    call: { model, reasoning, prompt, schema: JSON.parse(schemaText) as unknown },
    outputFile,
  };
}

export async function runCodexShim(args: readonly string[]): Promise<number> {
  if (args.join(' ') === 'login status') {
    process.stdout.write('Confined provider broker available\n');
    return 0;
  }
  if (args.join(' ') === '--version') {
    process.stdout.write('codex delivery-proxy 1\n');
    return 0;
  }
  const { call, outputFile } = parseCodexProxyArgs(args);
  return new Promise((resolve, reject) => {
    const socket = createConnection('/tmp/aq-provider.sock');
    socket.setEncoding('utf8');
    let buffer = '';
    const heartbeat = setInterval(() => {
      process.stdout.write('{"type":"provider.waiting"}\n');
    }, 1000);
    const close = () => {
      clearInterval(heartbeat);
      socket.destroy();
    };
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(call)}\n`);
    });
    socket.once('error', (error) => {
      close();
      reject(error);
    });
    socket.once('end', () => {
      close();
      reject(new Error('confined provider broker disconnected'));
    });
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      if (Buffer.byteLength(buffer) > PROVIDER_MESSAGE_BYTES) {
        close();
        reject(new Error('confined provider response too large'));
        return;
      }
      const newline = buffer.indexOf('\n');
      if (newline < 0) {
        return;
      }
      try {
        const response: unknown = JSON.parse(buffer.slice(0, newline));
        if (
          typeof response !== 'object' ||
          response === null ||
          !('status' in response) ||
          typeof response.status !== 'number' ||
          !Number.isSafeInteger(response.status) ||
          !('output' in response) ||
          typeof response.output !== 'string'
        ) {
          throw new Error('invalid confined provider response');
        }
        if (response.status === 0) {
          writeFileSync(outputFile, response.output);
          process.stdout.write('{"type":"turn.completed"}\n');
        }
        close();
        resolve(response.status);
      } catch (error) {
        close();
        reject(new Error('confined provider response rejected', { cause: error }));
      }
    });
  });
}

if (path.resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await runCodexShim(process.argv.slice(2));
  } catch {
    process.stderr.write('confined provider request rejected\n');
    process.exitCode = 1;
  }
}
