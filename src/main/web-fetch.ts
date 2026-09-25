import { BlockList, isIP, type LookupFunction } from 'node:net';
import { lookup as dnsLookup } from 'node:dns';
import { Agent, fetch } from 'undici';
import { convert } from 'html-to-text';

const MAX_REDIRECTS = 5;
const TIMEOUT_MS = 15_000;
const MAX_BYTES = 2 * 1024 * 1024;
const MAX_CHARS = 20_000;
const TEXT_TYPES = /^(text\/(html|plain|markdown|xml|csv)|application\/(xhtml\+xml|xml|json|ld\+json|rss\+xml|atom\+xml))$/i;

export interface WebFetchResult { url: string; finalUrl: string; title?: string; contentType: string; text: string; nextStartChar?: number }

/** Addresses the agent may never reach: loopback, private, link-local, CGNAT, and reserved ranges. */
const blocked = new BlockList();
for (const [network, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]] as const) blocked.addSubnet(network, prefix, 'ipv4');
for (const [network, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96], ['2002::', 16]] as const) blocked.addSubnet(network, prefix, 'ipv6');

function publicAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return publicAddress(mapped);
  const family = isIP(address);
  return family !== 0 && !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** DNS lookup that refuses non-public answers, so redirects and rebinding cannot reach local hosts. */
const guardedLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) return (callback as (error: Error) => void)(error);
    const list = addresses as unknown as { address: string; family: number }[];
    const rejected = list.find(entry => !publicAddress(entry.address));
    if (rejected || !list.length) return (callback as (error: Error) => void)(Object.assign(new Error(`Blocked non-public address for ${hostname}.`), { code: 'EBLOCKED' }));
    if (options.all) (callback as (error: null, addresses: typeof list) => void)(null, list);
    else callback(null, list[0].address, list[0].family);
  });
};

const agent = new Agent({ connect: { lookup: guardedLookup }, headersTimeout: TIMEOUT_MS, bodyTimeout: TIMEOUT_MS });

/** Rejects URLs the agent may never fetch, before any approval prompt or network access. */
export function checkUrl(raw: string | URL): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Invalid URL.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be fetched.');
  if (url.username || url.password) throw new Error('URLs with embedded credentials cannot be fetched.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (isIP(host) && !publicAddress(host)) throw new Error('Local and private network addresses cannot be fetched.');
  if (host === 'localhost' || host.endsWith('.localhost')) throw new Error('Local and private network addresses cannot be fetched.');
  url.hash = '';
  return url;
}

async function readBounded(body: ReadableStream<Uint8Array> | null): Promise<{ bytes: Uint8Array; truncated: boolean }> {
  if (!body) return { bytes: new Uint8Array(), truncated: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > MAX_BYTES) {
      chunks.push(value.subarray(0, MAX_BYTES - size));
      size = MAX_BYTES;
      truncated = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    size += value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return { bytes, truncated };
}

function decode(bytes: Uint8Array, contentType: string): string {
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1];
  try { return new TextDecoder(charset ?? 'utf-8').decode(bytes); } catch { return new TextDecoder('utf-8').decode(bytes); }
}

const collapse = (text: string) => text.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();

/** Fetches a public web page as readable text for the agent, one bounded window at a time. */
export async function webFetch(rawUrl: string, options: { startChar?: number; signal: AbortSignal }): Promise<WebFetchResult> {
  const signal = AbortSignal.any([options.signal, AbortSignal.timeout(TIMEOUT_MS)]);
  const original = checkUrl(rawUrl);
  let url = original;
  for (let redirects = 0; ; redirects++) {
    const response = await fetch(url, { dispatcher: agent, redirect: 'manual', signal, headers: { accept: 'text/html,application/xhtml+xml,text/plain,text/markdown,application/json;q=0.9,*/*;q=0.5', 'user-agent': 'Mozilla/5.0 (compatible; Shellmate)' } })
      .catch((error: unknown) => {
        const cause = (error as { cause?: { code?: string; message?: string } }).cause;
        if (cause?.code === 'EBLOCKED') throw new Error('Local and private network addresses cannot be fetched.');
        if (signal.aborted) throw new Error(options.signal.aborted ? 'Fetch cancelled.' : 'Fetch timed out.');
        throw new Error(`Fetch failed: ${cause?.message ?? (error instanceof Error ? error.message : 'network error')}`);
      });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel().catch(() => undefined);
      const location = response.headers.get('location');
      if (!location) throw new Error(`Redirect ${response.status} without a location.`);
      if (redirects >= MAX_REDIRECTS) throw new Error('Too many redirects.');
      url = checkUrl(new URL(location, url));
      continue;
    }
    const contentType = response.headers.get('content-type') ?? '';
    const mediaType = contentType.split(';')[0].trim();
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }
    if (mediaType && !TEXT_TYPES.test(mediaType)) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Unsupported content type ${mediaType}; only text, HTML, JSON, and XML pages can be read.`);
    }
    const { bytes, truncated } = await readBounded(response.body as ReadableStream<Uint8Array> | null);
    const raw = decode(bytes, contentType);
    const html = /html/i.test(mediaType) || (!mediaType && /^\s*<(!doctype html|html)/i.test(raw));
    const title = html ? /<title[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1]?.replace(/\s+/g, ' ').trim() : undefined;
    const full = collapse(html ? convert(raw, {
      wordwrap: false,
      selectors: [
        { selector: 'a', options: { ignoreHref: true } },
        { selector: 'img', format: 'skip' },
        { selector: 'nav', format: 'skip' },
        { selector: 'footer', format: 'skip' },
        { selector: 'script', format: 'skip' },
        { selector: 'style', format: 'skip' }
      ]
    }) : raw);
    const start = Math.max(0, Math.min(options.startChar ?? 0, full.length));
    const end = Math.min(full.length, start + MAX_CHARS);
    const text = full.slice(start, end) + (end >= full.length && truncated ? '\n[Page truncated at 2 MB.]' : '');
    return { url: original.toString(), finalUrl: url.toString(), title: title || undefined, contentType: mediaType, text, nextStartChar: end < full.length ? end : undefined };
  }
}
