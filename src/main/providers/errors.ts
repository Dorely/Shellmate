import { redactText } from '../diagnostics';

const MAX_BODY_BYTES = 32 * 1024;
const READ_DEADLINE_MS = 2_000;
const MAX_FIELD_LENGTH = 4_096;

export interface ProviderErrorDetails {
  message?: string;
  code?: string;
  type?: string;
  param?: string;
  requestId?: string;
  /** Provider-supplied replacement text, such as ElevenLabs' suggested prompt rewrite. */
  suggestion?: string;
}

type ErrorStatus = number | undefined;

/** A safe, bounded error for provider HTTP and streamed response failures. */
export class ProviderHttpError extends Error {
  readonly status: ErrorStatus;
  readonly provider: string;
  readonly details: ProviderErrorDetails;

  constructor(status: ErrorStatus, provider: string, details: ProviderErrorDetails = {}) {
    const safeProvider = sanitizeField(provider, []);
    const safeDetails = withFallbackMessage(sanitizeDetails(details, []));
    super(formatMessage(status, safeProvider, safeDetails));
    this.name = 'ProviderHttpError';
    this.status = status;
    this.provider = safeProvider;
    this.details = safeDetails;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static async fromResponse(
    response: Response,
    provider: string,
    secrets: string[] = [],
  ): Promise<ProviderHttpError> {
    const body = await readBodyBounded(response);
    const details = parsePayload(body.text, body.contentType, secrets);
    if (!details.requestId) details.requestId = headerValue(response.headers, ['x-request-id', 'request-id']);
    return new ProviderHttpError(response.status, provider, sanitizeDetails(details, secrets));
  }

  /** Builds the same safe error shape for provider stream/error events. */
  static fromPayload(provider: string, payload: unknown, secrets: string[] = []): ProviderHttpError {
    return new ProviderHttpError(undefined, provider, sanitizeDetails(parseObjectPayload(payload), secrets));
  }
}

/** Alias for callers that want to make the lack of an HTTP response explicit. */
export class ProviderResponseError extends ProviderHttpError {
  constructor(provider: string, details: ProviderErrorDetails = {}) {
    super(undefined, provider, details);
    this.name = 'ProviderResponseError';
  }

  static fromPayload(provider: string, payload: unknown, secrets: string[] = []): ProviderResponseError {
    return new ProviderResponseError(provider, sanitizeDetails(parseObjectPayload(payload), secrets));
  }
}

/** Returns only fields safe for structured diagnostics. */
export function diagnosticError(error: unknown): Record<string, unknown> {
  if (error instanceof ProviderHttpError) {
    return {
      name: error.name,
      provider: error.provider,
      status: error.status,
      message: error.message,
      details: { ...error.details },
    };
  }
  if (error instanceof Error) return {
    name: error.name.slice(0, 128),
    message: redactText(error.message, []).slice(0, MAX_FIELD_LENGTH),
  };
  return { name: 'Error', message: 'Unexpected provider error.' };
}

function parsePayload(text: string, contentType: string, secrets: string[]): ProviderErrorDetails {
  if (!text) return {};
  let payload: unknown;
  try { payload = JSON.parse(text) as unknown; } catch {
    return contentType.toLowerCase().includes('text/plain')
      ? { message: redactText(text, secrets).slice(0, MAX_FIELD_LENGTH) }
      : {};
  }
  return sanitizeDetails(parseObjectPayload(payload), secrets);
}

function parseObjectPayload(payload: unknown): ProviderErrorDetails {
  if (typeof payload === 'string') return { message: payload };
  if (!payload || typeof payload !== 'object') return {};
  const root = payload as Record<string, unknown>;
  const source = isRecord(root.error) ? root.error : isRecord(root.detail) ? root.detail : root;
  const details: ProviderErrorDetails = {};
  if (typeof root.detail === 'string') details.message = root.detail;
  for (const key of ['message', 'code', 'type', 'param'] as const) {
    if (typeof source[key] === 'string') details[key] = source[key];
  }
  if (isRecord(root.detail) && typeof root.detail.status === 'string' && !details.code) details.code = root.detail.status;
  const suggestion = suggestionFrom(source) ?? suggestionFrom(root.detail) ?? suggestionFrom(root);
  if (typeof suggestion === 'string') details.suggestion = suggestion;
  const requestId = source.request_id ?? source.requestId ?? root.request_id ?? root.requestId;
  if (typeof requestId === 'string') details.requestId = requestId;
  return details;
}

function suggestionFrom(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ['prompt_suggestion', 'composition_plan_suggestion'] as const) {
    if (typeof value[key] === 'string') return value[key];
  }
  return isRecord(value.data) ? suggestionFrom(value.data) : undefined;
}

function sanitizeDetails(details: ProviderErrorDetails, secrets: string[]): ProviderErrorDetails {
  const safe: ProviderErrorDetails = {};
  for (const key of ['message', 'code', 'type', 'param', 'requestId', 'suggestion'] as const) {
    if (typeof details[key] === 'string') safe[key] = sanitizeField(details[key]!, secrets);
  }
  return safe;
}

function withFallbackMessage(details: ProviderErrorDetails): ProviderErrorDetails {
  if (details.message) return details;
  const label = details.code ?? details.type ?? 'Provider request failed';
  details.message = details.param ? `${label} (parameter ${details.param})` : label;
  return details;
}

function sanitizeField(value: string, secrets: string[]): string {
  return redactText(value, secrets).slice(0, MAX_FIELD_LENGTH);
}

function formatMessage(status: ErrorStatus, provider: string, details: ProviderErrorDetails): string {
  const statusText = status === undefined ? 'returned an error' : `returned HTTP ${status}`;
  const summary = details.message ? `: ${details.message}` : '.';
  const parameter = details.param && details.message && !details.message.includes(details.param)
    ? ` (parameter ${details.param})` : '';
  const request = details.requestId ? ` (request ${details.requestId})` : '';
  const suggestion = details.suggestion ? ` Suggested replacement: ${details.suggestion}` : '';
  return `${provider} ${statusText}${summary}${parameter}${request}${suggestion}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function headerValue(headers: Headers, names: string[]): string | undefined {
  for (const name of names) {
    const value = headers.get(name);
    if (value) return value;
  }
  return undefined;
}

async function readBodyBounded(response: Response): Promise<{ text: string; contentType: string }> {
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.body) return { text: '', contentType };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    deadlineTimer = setTimeout(() => reject(new Error('body read deadline')), READ_DEADLINE_MS);
  });
  try {
    while (total < MAX_BODY_BYTES) {
      const next = await Promise.race([reader.read(), deadline]);
      if (next.done) break;
      const bytes = next.value as Uint8Array;
      const take = Math.min(bytes.byteLength, MAX_BODY_BYTES - total);
      if (take) chunks.push(bytes.slice(0, take));
      total += take;
      if (take < bytes.byteLength) break;
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return { text: new TextDecoder().decode(result), contentType };
  } catch {
    return { text: '', contentType };
  } finally {
    if (deadlineTimer) clearTimeout(deadlineTimer);
    try { void reader.cancel().catch(() => undefined); } catch { /* already closed */ }
    try { reader.releaseLock(); } catch { /* already released */ }
  }
}
