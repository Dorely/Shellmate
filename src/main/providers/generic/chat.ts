import { redactText } from '../../diagnostics';
import { ProviderHttpError, ProviderResponseError } from '../errors';
import { parseJsonPayload, readSseStream, type SseFrame } from './sse';

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool';
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }
  | { type: 'input_audio'; input_audio: { data: string; format: string } };
export interface ChatMessage {
  role: ChatRole;
  content?: string | ChatContentPart[] | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export interface ChatTurnInput {
  model: string;
  messages: ChatMessage[];
  tools?: unknown[];
  effort?: string;
  streamUsage?: boolean;
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
}

export interface ChatTurnResult {
  text: string;
  calls: { id: string; name: string; arguments: string }[];
  usage?: unknown;
  requestId?: string | null;
}

export interface ChatClientOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl: string;
  apiKey?: string | null;
}

function authHeaders(apiKey?: string | null): Record<string, string> {
  return apiKey?.trim()
    ? { authorization: `Bearer ${apiKey.trim()}` }
    : {};
}

function toolCallKey(call: { id?: string; index?: number }): string {
  if (typeof call.id === 'string' && call.id) return call.id;
  if (typeof call.index === 'number') return `index:${call.index}`;
  return 'index:0';
}

export function toChatMessages(input: unknown[], instructions: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (instructions.trim()) messages.push({ role: 'system', content: instructions });
  let pendingCalls: NonNullable<ChatMessage['tool_calls']> = [];
  const flushCalls = () => {
    if (pendingCalls.length) {
      messages.push({ role: 'assistant', content: null, tool_calls: pendingCalls });
      pendingCalls = [];
    }
  };
  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const value = item as Record<string, unknown>;
    if (value.role === 'user' && Array.isArray(value.content)) {
      flushCalls();
      const parts: ChatContentPart[] = [];
      let text = '';
      let media = false;
      const flushText = () => { if (text) { parts.push({ type: 'text', text }); text = ''; } };
      for (const rawPart of value.content) {
        const part = rawPart as { type?: string; text?: string; image_url?: unknown; input_audio?: { data?: unknown; format?: unknown } };
        if (part.type === 'input_text' && typeof part.text === 'string') text += part.text;
        else if (part.type === 'input_image' && typeof part.image_url === 'string') {
          flushText();
          parts.push({ type: 'image_url', image_url: { url: part.image_url } });
          media = true;
        } else if (part.type === 'input_audio' && typeof part.input_audio?.data === 'string') {
          flushText();
          parts.push({ type: 'input_audio', input_audio: { data: part.input_audio.data, format: typeof part.input_audio.format === 'string' ? part.input_audio.format : 'wav' } });
          media = true;
        }
      }
      flushText();
      if (!media) {
        const joined = parts.map(part => (part as { text?: string }).text ?? '').join('');
        messages.push({ role: 'user', content: joined });
        continue;
      }
      messages.push({ role: 'user', content: parts });
      continue;
    }
    if (value.type === 'message' && Array.isArray(value.content)) {
      flushCalls();
      const text = value.content
        .map(part => {
          const entry = part as { type?: string; text?: string; refusal?: string };
          if (entry.type === 'output_text' && typeof entry.text === 'string') return entry.text;
          if (entry.type === 'refusal' && typeof entry.refusal === 'string') return entry.refusal;
          if (typeof entry.text === 'string') return entry.text;
          return '';
        })
        .join('');
      messages.push({ role: 'assistant', content: text });
      continue;
    }
    if (value.type === 'function_call' && typeof value.call_id === 'string') {
      pendingCalls.push({
        id: value.call_id,
        type: 'function',
        function: { name: typeof value.name === 'string' ? value.name : '', arguments: typeof value.arguments === 'string' ? value.arguments : '{}' },
      });
      continue;
    }
    if (value.type === 'function_call_output' && typeof value.call_id === 'string') {
      flushCalls();
      messages.push({ role: 'tool', tool_call_id: value.call_id, content: typeof value.output === 'string' ? value.output : JSON.stringify(value.output ?? null) });
    }
  }
  flushCalls();
  return messages;
}

export async function postWithEffortFallback(args: {
  kind: 'chat-completions' | 'responses' | 'codex-account';
  effort?: string;
  fetchImpl: typeof globalThis.fetch;
  url: string;
  headers: Record<string, string>;
  buildBody: (effortFields: Record<string, unknown>) => Record<string, unknown>;
  signal?: AbortSignal;
  providerLabel: string;
  secrets: string[];
}): Promise<Response> {
  const trimmed = args.effort?.trim();
  const send = (effortFields: Record<string, unknown>) =>
    args.fetchImpl(args.url, { method: 'POST', headers: args.headers, body: JSON.stringify(args.buildBody(effortFields)), signal: args.signal });
  if (!trimmed) return send({});
  if (args.kind === 'codex-account') return send({ reasoning: { effort: trimmed } });
  // Responses takes reasoning.effort; Chat Completions takes a top-level reasoning_effort.
  const first = await send(args.kind === 'responses' ? { reasoning: { effort: trimmed } } : { reasoning_effort: trimmed });
  if (first.ok || first.status !== 400) return first;
  let probe = '';
  try {
    probe = await first.clone().text();
  } catch {
    probe = '';
  }
  if (!(args.kind === 'responses' ? /reasoning/i : /reasoning[_-]?effort/i).test(probe)) {
    throw await ProviderHttpError.fromResponse(first, args.providerLabel, args.secrets);
  }
  return send({});
}

/** Converts flat Responses-style function tools into the nested Chat Completions shape. */
export function toChatTools(tools: unknown[]): { type: 'function'; function: { name: string; description?: string; parameters?: unknown } }[] {
  return tools
    .map(tool => tool as { type?: string; name?: string; description?: string; parameters?: unknown })
    .filter(tool => tool.type === 'function' && tool.name)
    .map(tool => ({ type: 'function', function: { name: tool.name!, description: tool.description, parameters: tool.parameters } }));
}

export function toResponsesOutput(text: string, calls: { id: string; name: string; arguments: string }[]): unknown[] {
  const output: unknown[] = [];
  if (text) output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] });
  for (const call of calls) output.push({ type: 'function_call', call_id: call.id, name: call.name, arguments: call.arguments });
  return output;
}

export class ChatCompletionsClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly apiKey?: string | null;
  constructor(options: ChatClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  chatUrl(): string {
    return `${this.baseUrl}/chat/completions`;
  }

  modelsUrl(): string {
    return `${this.baseUrl}/models`;
  }

  secrets(): string[] {
    return this.apiKey?.trim() ? [this.apiKey.trim()] : [];
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const response = await this.fetcher(this.modelsUrl(), { headers: { accept: 'application/json', ...authHeaders(this.apiKey) }, signal });
    if (!response.ok) throw await ProviderHttpError.fromResponse(response, 'chat provider', this.secrets());
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      throw new ProviderResponseError('chat provider', { message: 'Model list was not valid JSON.' });
    }
    const entries = (payload as { data?: { id?: unknown; name?: unknown }[] }).data;
    if (!Array.isArray(entries)) throw new ProviderResponseError('chat provider', { message: 'Model list did not include a data array.' });
    return entries
      .map(entry => (typeof entry?.id === 'string' ? entry.id : typeof entry?.name === 'string' ? entry.name : ''))
      .map(id => id.trim())
      .filter(Boolean);
  }

  async streamChat(args: ChatTurnInput): Promise<ChatTurnResult> {
    try {
      return await this.request(args);
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      throw new Error(redactText(error instanceof Error ? error.message : 'Chat request failed.', this.secrets()));
    }
  }

  async probe(args: Omit<ChatTurnInput, 'streamUsage'> & { maxTokens?: number; includeImage?: boolean; includeAudio?: boolean; imageBase64?: string; audioBase64?: string }): Promise<void> {
    const messages = [...args.messages];
    if (args.includeImage && args.imageBase64) {
      const last = messages.at(-1);
      if (last && last.role === 'user' && typeof last.content === 'string') {
        last.content = [
          { type: 'text', text: last.content },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${args.imageBase64}` } },
        ] as unknown as string;
      }
    }
    if (args.includeAudio && args.audioBase64) {
      const last = messages.at(-1);
      if (last && last.role === 'user') {
        const content = typeof last.content === 'string' ? [{ type: 'text', text: last.content }] : [];
        last.content = [...content, { type: 'input_audio', input_audio: { data: args.audioBase64, format: 'wav' } }] as unknown as string;
      }
    }
    await this.request({ ...args, messages, streamUsage: false });
  }

  private async request(args: ChatTurnInput & { maxTokens?: number }): Promise<ChatTurnResult> {
    const response = await postWithEffortFallback({
      kind: 'chat-completions',
      effort: args.effort,
      fetchImpl: this.fetcher,
      url: this.chatUrl(),
      headers: { accept: 'text/event-stream', 'content-type': 'application/json', ...authHeaders(this.apiKey) },
      buildBody: effortFields => {
        const body: Record<string, unknown> = { model: args.model, stream: true, messages: args.messages, ...effortFields };
        const tools = toChatTools(args.tools ?? []);
        if (tools.length) {
          body.tools = tools;
          body.tool_choice = 'auto';
        }
        if (args.streamUsage !== false) body.stream_options = { include_usage: true };
        if (typeof args.maxTokens === 'number') body.max_tokens = args.maxTokens;
        return body;
      },
      signal: args.signal,
      providerLabel: 'chat provider',
      secrets: this.secrets(),
    });
    if (!response.ok) throw await ProviderHttpError.fromResponse(response, 'chat provider', this.secrets());
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
    if (!response.body) throw new Error('Chat response did not include a stream.');
    const failure = (payload: unknown, fallback: string) =>
      ProviderResponseError.fromPayload('chat provider', { ...(payload as Record<string, unknown> ?? {}), message: (payload as { message?: string } | null)?.message ?? fallback, request_id: requestId }, this.secrets());
    let text = '';
    let completed = false;
    let finishReason: string | null = null;
    let usage: unknown;
    const calls = new Map<string, { id: string; name: string; arguments: string }>();
    const order: string[] = [];
    const consume = async (frame: SseFrame): Promise<void> => {
      for (const line of frame.data) {
        const event = parseJsonPayload(line) as {
          choices?: { delta?: { content?: string | null; tool_calls?: { id?: string; index?: number; function?: { name?: string; arguments?: string } }[] }; finish_reason?: string | null }[];
          usage?: unknown;
          error?: unknown;
        } | undefined;
        if (!event) continue;
        if (event.error) throw failure(event.error, 'Chat response returned an error.');
        for (const choice of event.choices ?? []) {
          if (typeof choice.delta?.content === 'string' && choice.delta.content) {
            text += choice.delta.content;
            await args.onText?.(choice.delta.content);
          }
          for (const call of choice.delta?.tool_calls ?? []) {
            // Prefer explicit ids, then index keys, then the single in-flight
            // call: OpenAI-compatible gateways often omit index on fragments.
            let key: string | undefined;
            if (call.id && calls.has(call.id)) key = call.id;
            if (!key && typeof call.index === 'number' && calls.has(`index:${call.index}`)) key = `index:${call.index}`;
            if (!key && call.id) key = order.find(candidate => calls.get(candidate)?.id === call.id);
            if (!key && order.length === 1) key = order[0];
            if (!key) key = call.id ?? (typeof call.index === 'number' ? `index:${call.index}` : `index:${order.length}`);
            let entry = calls.get(key);
            if (!entry) {
              entry = { id: call.id ?? key, name: '', arguments: '' };
              calls.set(key, entry);
              order.push(key);
            }
            if (call.id && entry.id !== call.id) {
              calls.delete(key);
              const renamed = order.indexOf(key);
              if (renamed >= 0) order[renamed] = call.id;
              for (const [candidate, value] of [...calls]) {
                if (value === entry) calls.delete(candidate);
              }
              calls.set(call.id, entry);
              key = call.id;
            }
            if (call.id) entry.id = call.id;
            if (typeof call.function?.name === 'string' && call.function.name) entry.name = call.function.name;
            if (typeof call.function?.arguments === 'string') entry.arguments += call.function.arguments;
          }
          if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
        }
        if (event.usage !== undefined) usage = event.usage;
        if (finishReason === 'stop' || finishReason === 'tool_calls' || finishReason === 'length' || finishReason === 'content_filter') completed = true;
      }
    };
    try {
      await readSseStream(response.body, consume, () => completed);
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      throw failure({}, error instanceof Error ? error.message : 'Chat stream failed.');
    }
    if (!completed && !text && ![...calls.values()].length) throw failure({}, 'Chat response stream ended before completion.');
    if (finishReason === 'tool_calls' && ![...calls.values()].some(call => call.name)) {
      throw failure({}, 'Chat response stream ended during a tool call.');
    }
    const ordered = order.map(key => calls.get(key)!).filter(call => call.id && (call.name || call.arguments));
    return { text, calls: ordered, usage, requestId };
  }
}
