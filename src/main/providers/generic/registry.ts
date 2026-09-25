export type GenericProviderKind = 'chat-completions' | 'responses' | 'anthropic';

export interface ChatProvider {
  id: string;
  label: string;
  baseUrl: string;
  kind: GenericProviderKind;
}

export type CapabilityFlag = true | false | 'unknown';

export interface ChatModelRecord {
  id: string;
  providerId: string;
  slug: string;
  efforts: string[];
  maxTokens: number | null;
  vision: CapabilityFlag;
  audio: CapabilityFlag;
  effortResults: Record<string, 'pass' | 'fail'>;
  lastTestedAt: string;
  testError?: string;
}

const KIND_PATHS: Record<GenericProviderKind, { chat: string; models: string }> = {
  'chat-completions': { chat: '/chat/completions', models: '/models' },
  responses: { chat: '/responses', models: '/models' },
  anthropic: { chat: '/messages', models: '/models' },
};

export function isProviderKind(value: unknown): value is GenericProviderKind {
  return value === 'chat-completions' || value === 'responses' || value === 'anthropic';
}

export function normalizeBaseUrl(raw: string): string {
  const base = raw.trim().replace(/\/+$/, '');
  if (!base) throw new Error('A provider base URL is required.');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new Error('Provider base URL must be a valid http(s) URL.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Provider base URL must use http or https.');
  if (!url.hostname) throw new Error('Provider base URL must include a host.');
  if (url.username || url.password) throw new Error('Provider base URL must not embed credentials.');
  if (url.pathname === '' || url.pathname === '/') return `${url.origin}/v1`;
  return `${url.origin}${url.pathname}`;
}

export function chatPath(baseUrl: string, kind: GenericProviderKind): string {
  return `${normalizeBaseUrl(baseUrl)}${KIND_PATHS[kind].chat}`;
}

export function modelsPath(baseUrl: string): string {
  return `${normalizeBaseUrl(baseUrl)}/models`;
}

export function normalizeSlug(raw: string): string {
  const slug = raw.trim();
  if (!slug) throw new Error('A model name is required.');
  if (slug.length > 200) throw new Error('Model name is too long.');
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/.test(slug)) throw new Error('Model name contains unsupported characters.');
  return slug;
}

export function normalizeEfforts(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  const list = Array.isArray(raw) ? raw : [raw];
  const efforts = [...new Set(list.map(entry => String(entry).trim()).filter(Boolean))];
  if (efforts.length > 8) throw new Error('A model supports at most 8 effort levels.');
  for (const effort of efforts) {
    if (effort.length > 40 || !/^[A-Za-z0-9._-]+$/.test(effort)) throw new Error(`Effort "${effort}" contains unsupported characters.`);
  }
  return efforts;
}

export function effortsKey(efforts: string[]): string {
  return efforts.join(',');
}

export function parseProviders(raw: string): ChatProvider[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Saved chat providers are invalid.');
  }
  if (!Array.isArray(parsed)) throw new Error('Saved chat providers are invalid.');
  return parsed.filter((entry): entry is ChatProvider => {
    const candidate = entry as Partial<ChatProvider>;
    return typeof candidate.id === 'string' && typeof candidate.label === 'string' && typeof candidate.baseUrl === 'string' && isProviderKind(candidate.kind);
  });
}

export function parseModels(raw: string): ChatModelRecord[] {
  if (!raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('Saved chat models are invalid.');
  }
  if (!Array.isArray(parsed)) throw new Error('Saved chat models are invalid.');
  return parsed.filter((entry): entry is ChatModelRecord => {
    const candidate = entry as Partial<ChatModelRecord>;
    return typeof candidate.id === 'string' && typeof candidate.providerId === 'string' && typeof candidate.slug === 'string' && Array.isArray(candidate.efforts);
  });
}

export function validateProviderFields(label: string, baseUrl: string, kind: unknown): { label: string; baseUrl: string; kind: GenericProviderKind } {
  const name = label.trim();
  if (!name) throw new Error('A provider name is required.');
  if (name.length > 80) throw new Error('Provider name is too long.');
  if (!isProviderKind(kind)) throw new Error('Provider type must be chat-completions, responses, or anthropic.');
  return { label: name, baseUrl: normalizeBaseUrl(baseUrl), kind };
}
