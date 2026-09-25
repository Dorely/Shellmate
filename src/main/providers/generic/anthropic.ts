import { redactText } from '../../diagnostics';
import { ProviderHttpError, ProviderResponseError } from '../errors';
import { parseJsonPayload, readSseStream } from './sse';
import type { WebSearchActivity } from './responses';
import type { WebSource } from '../../../shared/types';

export interface AnthropicTurnInput {
  model: string;
  input: unknown[];
  instructions: string;
  tools?: unknown[];
  maxTokens: number;
  /** Anthropic web search server tool type to attach, such as web_search_20260209. */
  webSearch?: string | null;
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
  onWebSearch?: (activity: WebSearchActivity) => void | Promise<void>;
}

export interface AnthropicTurnResult {
  output: unknown[];
  calls: { id: string; name: string; arguments: string }[];
  usage?: unknown;
  requestId?: string | null;
  sources: WebSource[];
}

export interface AnthropicClientOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl: string;
  apiKey?: string | null;
  apiVersion?: string;
}

type AnthropicContent = Record<string, unknown>;
type AnthropicMessage = { content: AnthropicContent[]; role: 'user' | 'assistant' };
type StreamBlock = { type: string; start: Record<string, unknown>; id?: string; name?: string; text: string; json: string; thinking: string; signature: string; citations: unknown[] };

const MAX_CONTINUATIONS = 5;

function toolInputSchema(parameters: unknown): Record<string, unknown> {
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) return parameters as Record<string, unknown>;
  return { type: 'object' };
}

function parseInput(json: string): unknown {
  try { return json ? JSON.parse(json) : {}; } catch { return {}; }
}

/** Rebuilds a streamed content block so a paused turn can be resent unchanged. */
function rawBlock(entry: StreamBlock): AnthropicContent {
  if (entry.type === 'text') return { type: 'text', text: entry.text, ...(entry.citations.length ? { citations: entry.citations } : {}) };
  if (entry.type === 'thinking') return { type: 'thinking', thinking: entry.thinking, signature: entry.signature };
  if (entry.type === 'tool_use' || entry.type === 'server_tool_use') return { type: entry.type, id: entry.id, name: entry.name, input: parseInput(entry.json) };
  return entry.start;
}

function searchResultActivity(result: { tool_use_id?: unknown; content?: unknown }, blocks: Map<number, StreamBlock>): WebSearchActivity {
  const call = [...blocks.values()].find(entry => entry.type === 'server_tool_use' && entry.id === result.tool_use_id);
  const input = parseInput(call?.json ?? '') as { query?: unknown };
  const query = typeof input.query === 'string' && input.query ? input.query : 'web search';
  if (Array.isArray(result.content)) return { query, detail: `${result.content.length} results` };
  const code = (result.content as { error_code?: unknown } | undefined)?.error_code;
  return { query, detail: `failed: ${typeof code === 'string' ? code : 'unknown error'}` };
}

export function toAnthropicMessages(input: unknown[]): AnthropicMessage[] {
  const messages: AnthropicMessage[] = [];
  let assistantBlocks: AnthropicContent[] = [];
  let toolBlocks: AnthropicContent[] = [];
  const flushAssistant = () => {
    if (assistantBlocks.length) {
      messages.push({ role: 'assistant', content: assistantBlocks });
      assistantBlocks = [];
    }
  };
  const flushTools = () => {
    if (toolBlocks.length) {
      messages.push({ role: 'user', content: toolBlocks });
      toolBlocks = [];
    }
  };
  const assistantText = (text: string) => {
    if (text) assistantBlocks.push({ type: 'text', text });
  };
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (value.role === 'user' && Array.isArray(value.content)) {
      flushAssistant();
      flushTools();
      const blocks: AnthropicContent[] = [];
      let text = '';
      const flushText = () => { if (text) { blocks.push({ type: 'text', text }); text = ''; } };
      for (const rawPart of value.content) {
        const part = rawPart as { type?: string; text?: string; image_url?: unknown; input_audio?: { data?: unknown } };
        if (part.type === 'input_text' && typeof part.text === 'string') text += part.text;
        else if (part.type === 'input_image' && typeof part.image_url === 'string') {
          flushText();
          const match = /^data:([^;,]+);base64,(.*)$/.exec(part.image_url);
          if (match) blocks.push({ type: 'image', source: { type: 'base64', media_type: match[1], data: match[2] } });
          else text += '[unreadable image attachment]';
        } else if (part.type === 'input_audio' && typeof part.input_audio?.data === 'string') {
          flushText();
          blocks.push({ type: 'text', text: '[audio clip omitted: this provider accepts no audio input]' });
        }
      }
      flushText();
      messages.push({ role: 'user', content: blocks.length ? blocks : [{ type: 'text', text: '' }] });
      continue;
    }
    if (value.type === 'message' && Array.isArray(value.content)) {
      flushTools();
      const text = value.content
        .map(part => {
          const entry = part as { type?: string; text?: string; refusal?: string };
          if (typeof entry.text === 'string') return entry.text;
          if (typeof entry.refusal === 'string') return entry.refusal;
          return '';
        })
        .join('');
      assistantText(text);
      continue;
    }
    if (value.type === 'function_call' && typeof value.call_id === 'string') {
      flushTools();
      let parsed: unknown = {};
      try {
        parsed = typeof value.arguments === 'string' && value.arguments ? JSON.parse(value.arguments) : {};
      } catch {
        parsed = {};
      }
      assistantBlocks.push({ type: 'tool_use', id: value.call_id, name: typeof value.name === 'string' ? value.name : '', input: parsed });
      continue;
    }
    if (value.type === 'function_call_output' && typeof value.call_id === 'string') {
      flushAssistant();
      toolBlocks.push({ type: 'tool_result', tool_use_id: value.call_id, content: typeof value.output === 'string' ? value.output : JSON.stringify(value.output ?? null) });
      continue;
    }
    if (typeof value.type === 'string' && (value.type === 'thinking' || value.type === 'redacted_thinking')) {
      assistantBlocks.push(value as AnthropicContent);
    }
  }
  flushTools();
  flushAssistant();
  return messages;
}

export function toAnthropicTools(tools: unknown[] | undefined): { name: string; description?: string; input_schema: Record<string, unknown> }[] {
  return (tools ?? [])
    .filter(tool => (tool as { type?: string }).type === 'function')
    .map(tool => {
      const entry = tool as { name?: string; description?: string; parameters?: unknown };
      return { name: entry.name ?? '', description: entry.description, input_schema: toolInputSchema(entry.parameters) };
    })
    .filter(tool => tool.name);
}

export class AnthropicClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly apiKey?: string | null;
  private readonly apiVersion: string;
  constructor(options: AnthropicClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.apiVersion = options.apiVersion ?? '2023-06-01';
  }

  chatUrl(): string {
    return `${this.baseUrl}/messages`;
  }

  modelsUrl(): string {
    return `${this.baseUrl}/models`;
  }

  secrets(): string[] {
    return this.apiKey?.trim() ? [this.apiKey.trim()] : [];
  }

  headers(contentType = true): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', 'anthropic-version': this.apiVersion };
    if (contentType) headers['content-type'] = 'application/json';
    if (this.apiKey?.trim()) headers['x-api-key'] = this.apiKey.trim();
    return headers;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetcher(this.modelsUrl(), { headers: this.headers(false), signal });
    if (!response.ok) throw await ProviderHttpError.fromResponse(response, 'chat provider', this.secrets());
    const payload = (await response.json().catch(() => undefined)) as { data?: { id?: unknown; name?: unknown }[] } | undefined;
    if (!payload || !Array.isArray(payload.data)) throw new ProviderResponseError('chat provider', { message: 'Model list did not include a data array.' });
    return payload.data
      .map(entry => (typeof entry?.id === 'string' ? entry.id : typeof entry?.name === 'string' ? entry.name : ''))
      .map(id => id.trim())
      .filter(Boolean);
  }

  async streamChat(args: AnthropicTurnInput): Promise<AnthropicTurnResult> {
    try {
      return await this.request(args);
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      throw new Error(redactText(error instanceof Error ? error.message : 'Chat request failed.', this.secrets()));
    }
  }

  private async request(args: AnthropicTurnInput): Promise<AnthropicTurnResult> {
    if (!Number.isInteger(args.maxTokens) || args.maxTokens <= 0) throw new Error('Anthropic max_tokens must be a positive integer.');
    const tools: Record<string, unknown>[] = toAnthropicTools(args.tools);
    if (args.webSearch) tools.push({ type: args.webSearch, name: 'web_search', max_uses: 5 });
    const messages = toAnthropicMessages(args.input);
    const sources = new Map<string, WebSource>();
    const calls: { id: string; name: string; arguments: string }[] = [];
    let text = '';
    let usage: unknown;
    let requestId: string | null = null;
    // Server tools can pause a long turn; resending the paused assistant content resumes it.
    for (let continuation = 0; ; continuation++) {
      const round = await this.round(args, tools, messages, sources);
      text += round.text; usage = round.usage; requestId = round.requestId;
      calls.push(...round.calls);
      if (round.stopReason !== 'pause_turn' || continuation >= MAX_CONTINUATIONS) break;
      messages.push({ role: 'assistant', content: round.content });
    }
    const output: unknown[] = [];
    if (text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    for (const call of calls) output.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
    return { output, calls, usage, requestId, sources: [...sources.values()] };
  }

  private async round(args: AnthropicTurnInput, tools: Record<string, unknown>[], messages: AnthropicMessage[], sources: Map<string, WebSource>) {
    const body: Record<string, unknown> = {
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.instructions || 'You are a helpful assistant.',
      messages,
      stream: true,
    };
    if (tools.length) {
      body.tools = tools;
      body.tool_choice = { type: 'auto' };
    }
    const response = await this.fetcher(this.chatUrl(), { method: 'POST', headers: this.headers(), body: JSON.stringify(body), signal: args.signal });
    if (!response.ok) throw await ProviderHttpError.fromResponse(response, 'chat provider', this.secrets());
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id') ?? response.headers.get('anthropic-request-id');
    if (!response.body) throw new Error('Chat response did not include a stream.');
    const failure = (payload: unknown, fallback: string) =>
      ProviderResponseError.fromPayload('chat provider', { ...((payload as Record<string, unknown>) ?? {}), message: (payload as { message?: string } | null)?.message ?? fallback, request_id: requestId }, this.secrets());
    let text = '';
    let stopReason: string | null = null;
    let usage: unknown;
    let stopped = false;
    const blocks = new Map<number, StreamBlock>();
    const order: number[] = [];
    const block = (index: number): StreamBlock => {
      let entry = blocks.get(index);
      if (!entry) {
        entry = { type: 'text', start: {}, text: '', json: '', thinking: '', signature: '', citations: [] };
        blocks.set(index, entry);
        order.push(index);
      }
      return entry;
    };
    const consume = async (frame: { data: string[] }): Promise<void> => {
      for (const line of frame.data) {
        const event = parseJsonPayload(line) as {
          type?: string;
          index?: number;
          content_block?: Record<string, unknown> & { type?: string; id?: string; name?: string; text?: string };
          delta?: { type?: string; text?: string; partial_json?: string; thinking?: string; signature?: string; citation?: { url?: unknown; title?: unknown }; stop_reason?: unknown };
          stop_reason?: string | null;
          usage?: unknown;
          message?: { usage?: unknown };
          error?: unknown;
        } | undefined;
        if (!event) continue;
        switch (event.type) {
          case 'content_block_start': {
            if (typeof event.index === 'number') {
              const entry = block(event.index);
              entry.start = event.content_block ?? {};
              entry.type = event.content_block?.type ?? 'text';
              if (event.content_block?.id) entry.id = event.content_block.id;
              if (event.content_block?.name) entry.name = event.content_block.name;
              if (typeof event.content_block?.text === 'string') {
                entry.text += event.content_block.text;
                text += event.content_block.text;
                await args.onText?.(event.content_block.text);
              }
              if (entry.type === 'web_search_tool_result') await args.onWebSearch?.(searchResultActivity(entry.start, blocks));
            }
            break;
          }
          case 'content_block_delta': {
            if (typeof event.index === 'number') {
              const entry = block(event.index);
              const delta = event.delta;
              if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
                entry.text += delta.text;
                text += delta.text;
                await args.onText?.(delta.text);
              } else if (delta?.type === 'input_json_delta' && typeof delta.partial_json === 'string') {
                entry.json += delta.partial_json;
              } else if (delta?.type === 'thinking_delta' && typeof delta.thinking === 'string') {
                entry.thinking += delta.thinking;
              } else if (delta?.type === 'signature_delta' && typeof delta.signature === 'string') {
                entry.signature += delta.signature;
              } else if (delta?.type === 'citations_delta' && delta.citation) {
                entry.citations.push(delta.citation);
                const { url, title } = delta.citation;
                if (typeof url === 'string' && !sources.has(url)) sources.set(url, { url, ...(typeof title === 'string' && title ? { title } : {}) });
              }
            }
            break;
          }
          case 'message_delta': {
            if (event.stop_reason !== undefined) stopReason = event.stop_reason;
            if (typeof event.delta?.stop_reason === 'string') stopReason = event.delta.stop_reason;
            if (event.usage !== undefined) usage = event.usage;
            if (event.delta && typeof event.delta === 'object' && !('stop_reason' in (event.delta as Record<string, unknown>))) {
              usage = { ...((usage as Record<string, unknown>) ?? {}), ...(event.delta as Record<string, unknown>) };
            }
            break;
          }
          case 'message_start': {
            if (event.message?.usage !== undefined) usage = event.message.usage;
            break;
          }
          case 'message_stop':
            stopped = true;
            break;
          case 'error':
            throw failure(event.error ?? event, 'Chat response returned an error.');
          default:
            break;
        }
      }
    };
    try {
      await readSseStream(response.body, consume, () => stopped);
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      throw failure({}, error instanceof Error ? error.message : 'Chat stream failed.');
    }
    if (!stopped && stopReason === null && !text && ![...blocks.values()].some(entry => entry.type === 'tool_use')) {
      throw failure({}, 'Chat response stream ended before completion.');
    }
    const calls: { id: string; name: string; arguments: string }[] = [];
    const content: AnthropicContent[] = [];
    for (const index of order) {
      const entry = blocks.get(index)!;
      content.push(rawBlock(entry));
      if (entry.type !== 'tool_use' || !entry.id || !entry.name) continue;
      calls.push({ id: entry.id, name: entry.name, arguments: entry.json || '{}' });
    }
    if (stopReason === 'tool_use' && !calls.length) throw failure({}, 'Chat response stream ended during a tool call.');
    return { text, calls, usage, requestId, stopReason, content };
  }
}
