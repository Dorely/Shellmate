import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync, renameSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_ARCHIVES = 3;
const REDACTED = '[redacted]';
const SECRET_KEY = /^(?:authorization|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|id[_-]?token|token|password|passwd|cookie|set-cookie|client[_-]?secret|secret|private[_-]?key)$/i;
const QUERY_SECRET = /([?&](?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|apikey|authorization|token|key|signature)=)[^&#\s"'<>]*/gi;
const BEARER = /\bBearer\s+[^\s,;]+/gi;
const OPENAI_KEY = /\b(?:sk|sk-proj|sk-live|sk-test)[-_][A-Za-z0-9_-]+/gi;
const JWT = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g;
const MAX_STRING_LENGTH = 8192;

/** Redacts credentials and token-like values from arbitrary provider text. */
export function redactText(text: string, secrets: string[] = []): string {
  let result = text;
  for (const secret of secrets) {
    if (!secret) continue;
    result = result.replace(new RegExp(escapeRegExp(secret), 'g'), REDACTED);
  }
  return result
    .replace(QUERY_SECRET, `$1${REDACTED}`)
    .replace(BEARER, `Bearer ${REDACTED}`)
    .replace(OPENAI_KEY, REDACTED)
    .replace(JWT, REDACTED);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sanitize(value: unknown, secrets: string[], seen: WeakSet<object>): unknown {
  if (typeof value === 'string') return redactText(value, secrets).slice(0, MAX_STRING_LENGTH);
  if (value === null || typeof value !== 'object') {
    return typeof value === 'bigint' ? String(value) : value;
  }
  if (seen.has(value)) return '[circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets, seen));
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    result[key] = SECRET_KEY.test(key) ? REDACTED : sanitize(item, secrets, seen);
  }
  return result;
}

export interface DiagnosticLogOptions {
  maxBytes?: number;
  maxArchives?: number;
  /** Runtime values to scrub in addition to the standard token patterns. */
  secrets?: string[];
}

/** Best-effort bounded JSONL diagnostics in the profile's logs directory. */
export class DiagnosticLog {
  private readonly path: string;
  private readonly maxBytes: number;
  private readonly maxArchives: number;
  private readonly secrets: string[];

  constructor(profileDirectory: string, options: DiagnosticLogOptions = {}) {
    this.path = join(profileDirectory, 'logs', 'diagnostics.jsonl');
    this.maxBytes = Math.max(1, options.maxBytes ?? DEFAULT_MAX_BYTES);
    this.maxArchives = Math.max(0, Math.floor(options.maxArchives ?? DEFAULT_MAX_ARCHIVES));
    this.secrets = options.secrets ?? [];
  }

  /** Returns a UUID only when the complete record is persisted. */
  record(event: string, details: Record<string, unknown>): string | null {
    try {
      const id = randomUUID();
      const payload = {
        id,
        timestamp: new Date().toISOString(),
        event: redactText(event, this.secrets).slice(0, MAX_STRING_LENGTH),
        details: sanitize(details, this.secrets, new WeakSet<object>()),
      };
      const line = `${JSON.stringify(payload)}\n`;
      const bytes = Buffer.byteLength(line, 'utf8');
      mkdirSync(join(this.path, '..'), { recursive: true });
      let currentBytes = 0;
      try { currentBytes = statSync(this.path).size; } catch { /* first write */ }
      if (currentBytes > 0 && currentBytes + bytes > this.maxBytes) this.rotate();
      appendFileSync(this.path, line, { encoding: 'utf8', flag: 'a' });
      return id;
    } catch {
      return null;
    }
  }

  private rotate(): void {
    if (this.maxArchives === 0) {
      try { unlinkSync(this.path); } catch { /* absent */ }
      return;
    }
    for (let index = this.maxArchives; index >= 1; index -= 1) {
      const source = index === 1 ? this.path : `${this.path}.${index - 1}`;
      const destination = `${this.path}.${index}`;
      try { unlinkSync(destination); } catch { /* absent */ }
      try { renameSync(source, destination); } catch { /* absent */ }
    }
  }

  /** Exposed for diagnostics inspection and tests; returns only log file paths. */
  files(): string[] {
    try {
      return readdirSync(join(this.path, '..'))
        .filter(name => name === 'diagnostics.jsonl' || /^diagnostics\.jsonl\.\d+$/.test(name))
        .map(name => join(this.path, '..', name));
    } catch { return []; }
  }
}

export default DiagnosticLog;
