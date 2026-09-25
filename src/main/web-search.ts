import { secretName, type SecureStore } from './providers/secrets';
import { ProviderHttpError } from './providers/errors';
import { redactText } from './diagnostics';
import type { Store } from './store';
import type { SearchBackendId, WebSearchStatus } from '../shared/types';

export interface SearchResult { title: string; url: string; snippet: string }

interface SearchBackend {
  label: string;
  /** Returns raw JSON. Request URLs can carry the key, so they never appear in errors. */
  request(query: string, count: number, key: string, signal: AbortSignal): Promise<Response>;
  results(payload: Record<string, unknown>): SearchResult[];
}

const text = (value: unknown) => typeof value === 'string' ? value.trim() : '';
const BACKEND_IDS: SearchBackendId[] = ['serpapi', 'tavily'];

const BACKENDS: Record<SearchBackendId, SearchBackend> = {
  serpapi: {
    label: 'SerpApi',
    request: (query, count, key, signal) => fetch(`https://serpapi.com/search.json?${new URLSearchParams({ engine: 'google', q: query, num: String(count), api_key: key })}`, { headers: { accept: 'application/json' }, signal }),
    results: payload => (Array.isArray(payload.organic_results) ? payload.organic_results as Record<string, unknown>[] : [])
      .map(item => ({ title: text(item.title), url: text(item.link), snippet: text(item.snippet) }))
  },
  tavily: {
    label: 'Tavily',
    request: (query, count, key, signal) => fetch('https://api.tavily.com/search', { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json', authorization: `Bearer ${key}` }, body: JSON.stringify({ query, max_results: count, search_depth: 'basic' }), signal }),
    results: payload => (Array.isArray(payload.results) ? payload.results as Record<string, unknown>[] : [])
      .map(item => ({ title: text(item.title), url: text(item.url), snippet: text(item.content) }))
  }
};

const isBackend = (value: unknown): value is SearchBackendId => typeof value === 'string' && (BACKEND_IDS as string[]).includes(value);

/** App-owned web search through a user-chosen search API; keys live only in SecureStore. */
export class WebSearchService {
  constructor(private readonly store: Store, private readonly secrets: SecureStore) {}

  backend(): SearchBackendId | null {
    const value = this.store.setting('web-search-backend', '');
    return isBackend(value) ? value : null;
  }

  private async key(backend: SearchBackendId): Promise<string | null> {
    try { return (await this.secrets.get(secretName('search-key', backend)))?.trim() || null; } catch { return null; }
  }

  async status(): Promise<WebSearchStatus> {
    const keys = { serpapi: false, tavily: false };
    for (const backend of BACKEND_IDS) keys[backend] = Boolean(await this.key(backend));
    return { backend: this.backend(), keys };
  }

  async configured(): Promise<boolean> {
    const backend = this.backend();
    return Boolean(backend && await this.key(backend));
  }

  async save(input: { backend: SearchBackendId | null; apiKey?: string; keyAction?: 'keep' | 'replace' | 'remove' }): Promise<void> {
    if (input.backend) {
      const action = input.keyAction ?? (input.apiKey?.trim() ? 'replace' : 'keep');
      if (action === 'replace') {
        if (!input.apiKey?.trim()) throw new Error('Enter an API key to replace the saved key.');
        await this.secrets.set(secretName('search-key', input.backend), input.apiKey.trim());
      } else if (action === 'remove') await this.secrets.delete(secretName('search-key', input.backend));
    }
    this.store.setSetting('web-search-backend', input.backend ?? '');
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    const backendId = this.backend();
    if (!backendId) throw new Error('No web search backend is configured.');
    const key = await this.key(backendId);
    if (!key) throw new Error('The web search backend has no saved API key.');
    const backend = BACKENDS[backendId];
    let response: Response;
    try { response = await backend.request(query, count, key, signal); }
    catch (error) { throw new Error(`${backend.label} request failed: ${redactText(error instanceof Error ? error.message : 'network error', [key])}`); }
    if (!response.ok) throw await ProviderHttpError.fromResponse(response, backend.label, [key]);
    const payload = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!payload || typeof payload !== 'object') throw new Error(`${backend.label} returned an unreadable response.`);
    if (typeof payload.error === 'string') throw new Error(`${backend.label}: ${redactText(payload.error, [key])}`);
    return backend.results(payload).filter(result => /^https?:\/\//i.test(result.url)).slice(0, count);
  }

  async test(): Promise<number> {
    return (await this.search('Shellmate web search test', 3, AbortSignal.timeout(20_000))).length;
  }
}
