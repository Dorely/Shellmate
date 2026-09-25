import { AnthropicClient } from './anthropic';
import { ChatCompletionsClient, toChatMessages } from './chat';
import { GenericResponsesClient } from './responses';
import type { ChatProvider, ChatModelRecord } from './registry';
import { chatPath } from './registry';

export interface CapabilityProbe {
  provider: ChatProvider;
  slug: string;
  efforts: string[];
  apiKey?: string | null;
  signal?: AbortSignal;
  fetch?: typeof globalThis.fetch;
}

export interface CapabilityOutcome {
  perEffort: Record<string, 'pass' | 'fail'>;
  failedEfforts: string[];
  maxTokens: number | null;
  vision: true | false | 'unknown';
  audio: true | false | 'unknown';
  hostedSearch: string | null;
  error?: string;
}

/** Newest first; the dynamic-filtering variant needs a recent Claude model. */
const ANTHROPIC_SEARCH_TOOLS = ['web_search_20260209', 'web_search_20250305'] as const;

const PIXEL_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const BLIP_WAV_BASE64 = 'UklGRiYAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABAAZGF0YQYAAAAA' + 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';
const MAX_TOKENS_LADDER = [128000, 64000, 32000, 16384, 8192] as const;
const ANTHROPIC_SAFE_FLOOR = 8192;

function probeTools(): unknown[] {
  return [{ type: 'function', name: 'probe', description: 'Connectivity probe.', parameters: { type: 'object', properties: {} } }];
}

function probeInstructions(): string {
  return 'Reply with the single word ok.';
}

function probeInput(): unknown[] {
  return [{ role: 'user', content: [{ type: 'input_text', text: 'Reply with the single word ok.' }] }];
}

function namesMaxTokens(error: unknown): boolean {
  return error instanceof Error && /max[_-]?tokens/i.test(error.message);
}

export async function runCapabilityProbe(probe: CapabilityProbe): Promise<CapabilityOutcome> {
  const secret = probe.apiKey?.trim() ? probe.apiKey.trim() : null;
  const perEffort: Record<string, 'pass' | 'fail'> = {};
  const failedEfforts: string[] = [];
  const targets = probe.efforts.length ? probe.efforts : [''];
  let lastError: string | undefined;
  for (const effort of targets) {
    try {
      await runBasicPing(probe, effort || undefined, secret);
      perEffort[effort || '(default)'] = 'pass';
    } catch (error) {
      perEffort[effort || '(default)'] = 'fail';
      failedEfforts.push(effort || '(default)');
      lastError = error instanceof Error ? error.message : 'Probe failed.';
    }
  }
  if (failedEfforts.length) return { perEffort, failedEfforts, maxTokens: null, vision: 'unknown', audio: 'unknown', hostedSearch: null, error: lastError };
  const maxTokens = probe.provider.kind === 'anthropic' ? await discoverMaxTokens(probe, targets[0] || undefined, secret) : null;
  const firstEffort = targets[0] || undefined;
  return {
    perEffort,
    failedEfforts,
    maxTokens,
    vision: await probeModality(probe, firstEffort, secret, 'vision'),
    // The Anthropic Messages API has no input-audio block, so audio input is
    // deterministically unsupported there and must not be probed as reachable.
    audio: probe.provider.kind === 'anthropic' ? false : await probeModality(probe, firstEffort, secret, 'audio'),
    hostedSearch: await probeHostedSearch(probe, firstEffort, secret, maxTokens),
  };
}

/** Returns the hosted web search tool type that actually ran a search, or null. */
async function probeHostedSearch(probe: CapabilityProbe, effort: string | undefined, secret: string | null, maxTokens: number | null): Promise<string | null> {
  if (probe.provider.kind === 'chat-completions') return null;
  const options = { fetch: probe.fetch, baseUrl: probe.provider.baseUrl, apiKey: secret };
  const input = [{ role: 'user', content: [{ type: 'input_text', text: 'Search the web for the current UTC date, then reply with it.' }] }];
  const instructions = 'Use web search before answering.';
  const candidates = probe.provider.kind === 'anthropic' ? ANTHROPIC_SEARCH_TOOLS : ['web_search'];
  for (const tool of candidates) {
    let searched = false;
    const onWebSearch = () => { searched = true; };
    try {
      if (probe.provider.kind === 'anthropic') await new AnthropicClient(options).streamChat({ model: probe.slug, input, instructions, webSearch: tool, maxTokens: maxTokens ?? ANTHROPIC_SAFE_FLOOR, signal: probe.signal, onWebSearch });
      else await new GenericResponsesClient(options).streamChat({ model: probe.slug, input, instructions, webSearch: true, effort, signal: probe.signal, onWebSearch });
      if (searched) return tool;
    } catch {
      // An unsupported tool type is rejected; try the next variant.
    }
  }
  return null;
}

async function runBasicPing(probe: CapabilityProbe, effort: string | undefined, secret: string | null): Promise<void> {
  const baseUrl = probe.provider.baseUrl;
  const options = { fetch: probe.fetch, baseUrl, apiKey: secret };
  const input = probeInput();
  if (probe.provider.kind === 'anthropic') {
    const discovered = await discoverMaxTokens(probe, effort, secret);
    await new AnthropicClient(options).streamChat({ model: probe.slug, input, instructions: probeInstructions(), tools: probeTools(), maxTokens: discovered, signal: probe.signal });
    return;
  }
  if (probe.provider.kind === 'responses') {
    await new GenericResponsesClient(options).streamChat({ model: probe.slug, input, instructions: probeInstructions(), tools: probeTools(), effort, signal: probe.signal });
    return;
  }
  await new ChatCompletionsClient(options).streamChat({ model: probe.slug, messages: toChatMessages(input, probeInstructions()), tools: probeTools(), effort, signal: probe.signal });
}

async function probeModality(probe: CapabilityProbe, effort: string | undefined, secret: string | null, kind: 'vision' | 'audio'): Promise<true | false | 'unknown'> {
  try {
    const baseUrl = probe.provider.baseUrl;
    const options = { fetch: probe.fetch, baseUrl, apiKey: secret };
    const messages = toChatMessages(probeInput(), probeInstructions());
    if (probe.provider.kind === 'anthropic') {
      const client = new AnthropicClient(options);
      const request = {
        model: probe.slug,
        max_tokens: ANTHROPIC_SAFE_FLOOR,
        system: probeInstructions(),
        stream: false,
        messages: [
          {
            role: 'user',
            content: kind === 'vision'
              ? [{ type: 'text', text: 'Describe this pixel.' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PIXEL_PNG_BASE64 } }]
              : [{ type: 'text', text: 'Transcribe this blip.' }],
          },
        ],
      };
      const response = await (probe.fetch ?? globalThis.fetch)(chatPath(baseUrl, 'anthropic'), {
        method: 'POST',
        headers: client.headers(),
        body: JSON.stringify(request),
        signal: probe.signal,
      });
      if (!response.ok) {
        const status = response.status;
        await response.body?.cancel().catch(() => undefined);
        if (status === 400 || status === 422) return false;
        return 'unknown';
      }
      await response.body?.cancel().catch(() => undefined);
      return true;
    }
    const client = probe.provider.kind === 'responses'
      ? new GenericResponsesClient(options)
      : new ChatCompletionsClient(options);
    const fetcher = probe.fetch ?? globalThis.fetch.bind(globalThis);
    const url = probe.provider.kind === 'responses' ? `${baseUrl.replace(/\/+$/, '')}/responses` : `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (secret) headers.authorization = `Bearer ${secret}`;
    const body = probe.provider.kind === 'responses'
      ? {
        model: probe.slug,
        input: [
          {
            role: 'user',
            content: kind === 'vision'
              ? [{ type: 'input_text', text: 'Describe this pixel.' }, { type: 'input_image', image_url: `data:image/png;base64,${PIXEL_PNG_BASE64}` }]
              : [{ type: 'input_text', text: 'Transcribe this blip.' }, { type: 'input_audio', input_audio: { data: BLIP_WAV_BASE64, format: 'wav' } }],
          },
        ],
        instructions: probeInstructions(),
        stream: false,
        ...(effort ? { reasoning: { effort } } : {}),
      }
      : {
        model: probe.slug,
        stream: false,
        messages: kind === 'vision'
          ? [{ role: 'user', content: [{ type: 'text', text: 'Describe this pixel.' }, { type: 'image_url', image_url: { url: `data:image/png;base64,${PIXEL_PNG_BASE64}` } }] }]
          : [...messages, { role: 'user', content: 'Transcribe the attached audio.' }],
        ...(effort ? { reasoning_effort: effort } : {}),
      };
    if (kind === 'audio' && probe.provider.kind !== 'responses') {
      const list = (body as { messages: { role: string; content: unknown }[] }).messages;
      const last = list.at(-1);
      if (last) last.content = [{ type: 'text', text: 'Transcribe this blip.' }, { type: 'input_audio', input_audio: { data: BLIP_WAV_BASE64, format: 'wav' } }];
    }
    void client;
    const response = await fetcher(url, { method: 'POST', headers, body: JSON.stringify(body), signal: probe.signal });
    if (!response.ok) {
      const status = response.status;
      await response.body?.cancel().catch(() => undefined);
      if (status === 400 || status === 422) return false;
      return 'unknown';
    }
    await response.body?.cancel().catch(() => undefined);
    return true;
  } catch {
    return 'unknown';
  }
}

async function discoverMaxTokens(probe: CapabilityProbe, effort: string | undefined, secret: string | null): Promise<number> {
  const client = new AnthropicClient({ fetch: probe.fetch, baseUrl: probe.provider.baseUrl, apiKey: secret });
  for (const value of MAX_TOKENS_LADDER) {
    try {
      await client.streamChat({ model: probe.slug, input: probeInput(), instructions: probeInstructions(), tools: probeTools(), maxTokens: value, signal: probe.signal });
      return value;
    } catch (error) {
      if (!namesMaxTokens(error)) throw error;
    }
  }
  return ANTHROPIC_SAFE_FLOOR;
}


export { PIXEL_PNG_BASE64, BLIP_WAV_BASE64, MAX_TOKENS_LADDER, ANTHROPIC_SAFE_FLOOR };
