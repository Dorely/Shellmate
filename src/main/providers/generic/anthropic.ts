import { redactText } from '../../diagnostics';
import { ProviderHttpError, ProviderResponseError } from '../errors';
import { parseJsonPayload, readSseStream } from './sse';

export interface AnthropicTurnInput {
  model: string;
  input: unknown[];
  instructions: string;
  tools?: unknown[];
  maxTokens: number;
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
}

export interface AnthropicTurnResult {
  output: unknown[];
  calls: { id: string; name: string; arguments: string }[];
  usage?: unknown;
  requestId?: string | null;
}

export interface AnthropicClientOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl: string;
  apiKey?: string | null;
  apiVersion?: string;
}

type AnthropicContent = Record<string, unknown>;

function toolInputSchema(parameters: unknown): Record<string, unknown> {
  if (parameters && typeof parameters === 'object' && !Array.isArray(parameters)) return parameters as Record<string, unknown>;
  return { type: 'object' };
}

export function toAnthropicMessages(input: unknown[]): { content: AnthropicContent[]; role: 'user' | 'assistant' }[] {
  const messages: { content: AnthropicContent[]; role: 'user' | 'assistant' }[] = [];
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
      const entry = (tool as { function?: { name?: string; description?: string; parameters?: unknown } }).function ?? {};
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
    const tools = toAnthropicTools(args.tools);
    const body: Record<string, unknown> = {
      model: args.model,
      max_tokens: args.maxTokens,
      system: args.instructions || 'You are a helpful assistant.',
      messages: toAnthropicMessages(args.input),
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
    const blocks = new Map<number, { type: string; id?: string; name?: string; text: string; json: string }>();
    const order: number[] = [];
    const block = (index: number): { type: string; id?: string; name?: string; text: string; json: string } => {
      let entry = blocks.get(index);
      if (!entry) {
        entry = { type: 'text', text: '', json: '' };
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
          content_block?: { type?: string; id?: string; name?: string; text?: string };
          delta?: { type?: string; text?: string; partial_json?: string };
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
              entry.type = event.content_block?.type ?? 'text';
              if (event.content_block?.id) entry.id = event.content_block.id;
              if (event.content_block?.name) entry.name = event.content_block.name;
              if (typeof event.content_block?.text === 'string') {
                entry.text += event.content_block.text;
                text += event.content_block.text;
                await args.onText?.(event.content_block.text);
              }
            }
            break;
          }
          case 'content_block_delta': {
            if (typeof event.index === 'number') {
              const entry = block(event.index);
              if (event.delta?.type === 'text_delta' && typeof event.delta.text === 'string') {
                entry.text += event.delta.text;
                text += event.delta.text;
                await args.onText?.(event.delta.text);
              } else if (event.delta?.type === 'input_json_delta' && typeof event.delta.partial_json === 'string') {
                entry.json += event.delta.partial_json;
              }
            }
            break;
          }
          case 'message_delta': {
            if (event.stop_reason !== undefined) stopReason = event.stop_reason;
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
    const output: unknown[] = [];
    const calls: { id: string; name: string; arguments: string }[] = [];
    if (text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
    for (const index of order) {
      const entry = blocks.get(index);
      if (!entry || entry.type !== 'tool_use' || !entry.id || !entry.name) continue;
      const call = { id: entry.id, name: entry.name, arguments: entry.json || '{}' };
      output.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
      calls.push(call);
    }
    if (stopReason === 'tool_use' && !calls.length) throw failure({}, 'Chat response stream ended during a tool call.');
    return { output, calls, usage, requestId };
  }
}
