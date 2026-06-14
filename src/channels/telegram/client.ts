import { isJsonObject, type JsonObject, type JsonValue } from '../../core/json.js';
import { DEFAULT_TELEGRAM_HTTP_TIMEOUT_SECONDS, telegramApiBase } from './config.js';

export type TelegramFailureKind =
  | 'http'
  | 'conflict'
  | 'unauthorized'
  | 'network'
  | 'timeout'
  | 'envelope'
  | 'parse';

const TELEGRAM_FAILURE_KINDS = [
  'http',
  'conflict',
  'unauthorized',
  'network',
  'timeout',
  'envelope',
  'parse',
] as const satisfies readonly TelegramFailureKind[];

export function isTelegramFailureKind(value: string): value is TelegramFailureKind {
  return (TELEGRAM_FAILURE_KINDS as readonly string[]).includes(value);
}

// `errorCode` (Bot API body) and `status` (HTTP) can diverge behind a proxy; classification prefers errorCode.
export interface TelegramFailure {
  readonly kind: TelegramFailureKind;
  readonly status?: number;
  readonly errorCode?: number;
  readonly description?: string;
}

export type TelegramCallResult =
  | { readonly ok: true; readonly body: JsonObject }
  | { readonly ok: false; readonly failure: TelegramFailure };

interface TelegramFailureSignals {
  readonly effective: number | undefined;
  readonly status: number | undefined;
  readonly errorCode: number | undefined;
  readonly description: string | undefined;
}

interface TelegramCallOptions {
  readonly get?: boolean;
  readonly timeoutSeconds?: number;
}

function failureKindFromCode(code: number): TelegramFailureKind {
  if (code === 409) {
    return 'conflict';
  }
  if (code === 401) {
    return 'unauthorized';
  }
  return 'http';
}

function withFailureFields(
  kind: TelegramFailureKind,
  fields: Pick<TelegramFailureSignals, 'status' | 'errorCode' | 'description'>,
): TelegramFailure {
  const { status, errorCode, description } = fields;
  return {
    kind,
    ...(status !== undefined ? { status } : {}),
    ...(errorCode !== undefined ? { errorCode } : {}),
    ...(description !== undefined ? { description } : {}),
  };
}

function classifyTelegramFailure(signals: TelegramFailureSignals): TelegramFailure {
  const { effective, status, errorCode, description } = signals;
  if (effective === undefined) {
    return withFailureFields('envelope', { status, errorCode, description });
  }
  return withFailureFields(failureKindFromCode(effective), { status, errorCode, description });
}

function buildTelegramRequest(
  method: string,
  params: URLSearchParams,
  options: TelegramCallOptions,
): { url: string; init: RequestInit } {
  const token = process.env.AGENT_QUORUM_TELEGRAM_BOT_TOKEN ?? '';
  const url = `${telegramApiBase()}/bot${token}/${method}`;
  const timeoutSeconds =
    options.timeoutSeconds ??
    Number(process.env.AGENT_QUORUM_TELEGRAM_HTTP_TIMEOUT ?? DEFAULT_TELEGRAM_HTTP_TIMEOUT_SECONDS);
  const signal = AbortSignal.timeout(timeoutSeconds * 1000);
  if (options.get) {
    return { url: `${url}?${params.toString()}`, init: { method: 'GET', signal } };
  }
  return {
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
      signal,
    },
  };
}

interface TelegramResponseBody {
  readonly bodyObj: JsonObject | undefined;
  readonly errorCode: number | undefined;
  readonly description: string | undefined;
}

// An unparseable or non-object body yields `bodyObj === undefined` rather than throwing.
async function readTelegramResponseBody(response: Response): Promise<TelegramResponseBody> {
  let parsed: JsonValue | undefined;
  try {
    parsed = JSON.parse(await response.text()) as JsonValue;
  } catch {
    parsed = undefined;
  }
  const bodyObj = isJsonObject(parsed) ? parsed : undefined;
  return {
    bodyObj,
    errorCode: typeof bodyObj?.error_code === 'number' ? bodyObj.error_code : undefined,
    description: typeof bodyObj?.description === 'string' ? bodyObj.description : undefined,
  };
}

// Parses the body even on a non-2xx response so the Bot API error_code can classify the failure.
export async function telegramCall(
  method: string,
  params: Record<string, string>,
  options: TelegramCallOptions = {},
): Promise<TelegramCallResult> {
  const { url, init } = buildTelegramRequest(method, new URLSearchParams(params), options);

  let response: Response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    const isTimeout = error instanceof Error && error.name === 'TimeoutError';
    return { ok: false, failure: { kind: isTimeout ? 'timeout' : 'network' } };
  }

  const { bodyObj, errorCode, description } = await readTelegramResponseBody(response);
  if (!response.ok) {
    return {
      ok: false,
      failure: classifyTelegramFailure({
        effective: errorCode ?? response.status,
        status: response.status,
        errorCode,
        description,
      }),
    };
  }
  if (bodyObj === undefined) {
    return { ok: false, failure: { kind: 'parse' } };
  }
  if (bodyObj.ok !== true) {
    return {
      ok: false,
      failure: classifyTelegramFailure({
        effective: errorCode,
        status: undefined,
        errorCode,
        description,
      }),
    };
  }
  return { ok: true, body: bodyObj };
}
