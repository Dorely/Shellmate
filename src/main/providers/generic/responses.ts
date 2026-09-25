import { redactText } from '../../diagnostics';
import { ProviderHttpError, ProviderResponseError } from '../errors';
import { postWithEffortFallback } from './chat';
import { parseJsonPayload, readSseStream } from './sse';

export interface ResponsesTurnInput {
  model: string;
  input: unknown[];
  instructions: string;
  tools?: unknown[];
  effort?: string;
  streamUsage?: boolean;
  signal?: AbortSignal;
  onText?: (text: string) => void | Promise<void>;
}

export interface ResponsesTurnResult {
  output: unknown[];
  calls: { id: string; name: string; arguments: string }[];
  usage?: unknown;
  requestId?: string | null;
}

export interface ResponsesClientOptions {
  fetch?: typeof globalThis.fetch;
  baseUrl: string;
  apiKey?: string | null;
}

function messageText(item: { content?: { type?: string; text?: string; refusal?: string }[] }): string {
  if (!Array.isArray(item?.content)) return '';
  return item.content
    .map(part => (part?.type === 'output_text' && typeof part.text === 'string' ? part.text : part?.type === 'refusal' && typeof part.refusal === 'string' ? part.refusal : ''))
    .join('');
}

export class GenericResponsesClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly baseUrl: string;
  private readonly apiKey?: string | null;
  constructor(options: ResponsesClientOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
  }

  chatUrl(): string {
    return `${this.baseUrl}/responses`;
  }

  modelsUrl(): string {
    return `${this.baseUrl}/models`;
  }

  secrets(): string[] {
    return this.apiKey?.trim() ? [this.apiKey.trim()] : [];
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.apiKey?.trim()) headers.authorization = `Bearer ${this.apiKey.trim()}`;
    const response = await this.fetcher(this.modelsUrl(), { headers, signal });
    if (!response.ok) throw await ProviderHttpError.fromResponse(response, 'chat provider', this.secrets());
    const payload = (await response.json().catch(() => undefined)) as { data?: { id?: unknown; name?: unknown }[] } | undefined;
    if (!payload || !Array.isArray(payload.data)) throw new ProviderResponseError('chat provider', { message: 'Model list did not include a data array.' });
    return payload.data
      .map(entry => (typeof entry?.id === 'string' ? entry.id : typeof entry?.name === 'string' ? entry.name : ''))
      .map(id => id.trim())
      .filter(Boolean);
  }

  async streamChat(args: ResponsesTurnInput): Promise<ResponsesTurnResult> {
    try {
      return await this.request(args);
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      throw new Error(redactText(error instanceof Error ? error.message : 'Chat request failed.', this.secrets()));
    }
  }

  private async request(args: ResponsesTurnInput): Promise<ResponsesTurnResult> {
    const headers: Record<string, string> = { accept: 'text/event-stream', 'content-type': 'application/json' };
    if (this.apiKey?.trim()) headers.authorization = `Bearer ${this.apiKey.trim()}`;
    const response = await postWithEffortFallback({
      kind: 'chat-completions',
      effort: args.effort,
      fetchImpl: this.fetcher,
      url: this.chatUrl(),
      headers,
      buildBody: effortFields => {
        const body: Record<string, unknown> = {
          model: args.model,
          stream: true,
          input: args.input,
          instructions: args.instructions || 'You are a helpful assistant.',
          ...effortFields,
        };
        if (args.tools?.length) {
          body.tools = args.tools;
          body.tool_choice = 'auto';
        }
        if (args.streamUsage !== false) body.stream_options = { include_usage: true };
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
      ProviderResponseError.fromPayload('chat provider', { ...((payload as Record<string, unknown>) ?? {}), message: (payload as { message?: string } | null)?.message ?? fallback, request_id: requestId }, this.secrets());
    let completed = false;
    let usage: unknown;
    const calls = new Map<string, { id: string; name: string; arguments: string; done: boolean }>();
    const orderedCalls: { id: string; name: string; arguments: string; done: boolean }[] = [];
    const messages = new Map<string, { text: string; streamed: boolean }>();
    const sequence: ({ kind: 'text'; message: { text: string; streamed: boolean } } | { kind: 'call'; call: { id: string; name: string; arguments: string; done: boolean } })[] = [];
    const upsertMessage = (item: { id?: unknown; item_id?: unknown }, outputIndex?: number) => {
      const id = typeof item?.id === 'string' ? item.id : typeof item?.item_id === 'string' ? item.item_id : undefined;
      const index = typeof outputIndex === 'number' ? `index:${outputIndex}` : undefined;
      let message = (id ? messages.get(id) : undefined) ?? (index ? messages.get(index) : undefined) ?? messages.get('unidentified');
      if (!message) {
        message = { text: '', streamed: false };
        sequence.push({ kind: 'text', message });
      }
      if (id) messages.set(id, message);
      if (index) messages.set(index, message);
      if (!id && !index) messages.set('unidentified', message);
      return message;
    };
    const upsertCall = (item: { call_id?: unknown; id?: unknown; name?: unknown }) => {
      const callId = typeof item?.call_id === 'string' ? item.call_id : typeof item?.id === 'string' ? item.id : undefined;
      if (!callId) return undefined;
      const existing = (typeof item.call_id === 'string' ? calls.get(item.call_id) : undefined) ?? (typeof item.id === 'string' ? calls.get(item.id) : undefined);
      const call = existing ?? { id: callId, name: typeof item.name === 'string' ? item.name : '', arguments: '', done: false };
      if (!existing) {
        orderedCalls.push(call);
        sequence.push({ kind: 'call', call });
      }
      if (typeof item.call_id === 'string') {
        call.id = item.call_id;
        calls.set(item.call_id, call);
      }
      if (typeof item.id === 'string') calls.set(item.id, call);
      if (typeof item.name === 'string' && item.name) call.name = item.name;
      return call;
    };
    const consume = async (frame: { data: string[] }): Promise<void> => {
      for (const line of frame.data) {
        const event = parseJsonPayload(line) as { type?: string; delta?: unknown; item?: { type?: string; id?: string; call_id?: string; name?: string; arguments?: string; content?: { type?: string; text?: string; refusal?: string }[] }; output_index?: number; call_id?: string; item_id?: string; arguments?: string; response?: { status?: string; error?: unknown; usage?: unknown; output?: unknown[] }; usage?: unknown; status?: string; error?: unknown } | undefined;
        if (!event) continue;
        switch (event.type) {
          case 'response.output_text.delta': {
            const delta = typeof event.delta === 'string' ? event.delta : '';
            if (delta) {
              const message = upsertMessage(event.item ?? {}, event.output_index);
              message.text += delta;
              message.streamed = true;
              await args.onText?.(delta);
            }
            break;
          }
          case 'response.output_item.added': {
            const item = event.item;
            if (item?.type === 'function_call') {
              const call = upsertCall(item);
              if (call && typeof item.arguments === 'string') call.arguments = item.arguments;
            } else if (item?.type === 'message') upsertMessage(item, event.output_index);
            break;
          }
          case 'response.function_call_arguments.delta': {
            const id = event.call_id ?? event.item_id;
            const call = typeof id === 'string' ? calls.get(id) : undefined;
            if (call && typeof event.delta === 'string') call.arguments += event.delta;
            break;
          }
          case 'response.function_call_arguments.done': {
            const id = event.call_id ?? event.item_id;
            const call = typeof id === 'string' ? calls.get(id) : undefined;
            if (call) {
              if (typeof event.arguments === 'string') call.arguments = event.arguments;
              call.done = true;
            }
            break;
          }
          case 'response.output_item.done': {
            const item = event.item;
            if (item?.type === 'function_call') {
              const call = upsertCall(item);
              if (call) {
                if (typeof item.arguments === 'string') call.arguments = item.arguments;
                call.done = true;
              }
            } else if (item?.type === 'message') {
              const message = upsertMessage(item, event.output_index);
              const finalText = messageText(item);
              if (finalText) message.text = finalText;
            }
            break;
          }
          case 'response.completed':
          case 'response.done': {
            if (event.status === 'failed' || event.response?.status === 'failed' || event.error || event.response?.error) {
              throw failure(event.response ?? event, 'Chat response failed.');
            }
            if (['incomplete', 'cancelled'].includes(event.status ?? event.response?.status ?? '')) {
              throw failure(event.response ?? event, 'Chat response was incomplete.');
            }
            completed = true;
            usage = event.response?.usage ?? event.usage;
            const output = Array.isArray(event.response?.output) ? event.response.output : [];
            for (const [index, item] of output.entries()) {
              const entry = item as { type?: string; call_id?: string; id?: string; name?: string; arguments?: string; content?: { type?: string; text?: string; refusal?: string }[] };
              if (entry?.type === 'function_call') {
                const call = upsertCall(entry);
                if (call) {
                  if (typeof entry.arguments === 'string') call.arguments = entry.arguments;
                  call.done = true;
                }
              } else if (entry?.type === 'message') {
                const message = upsertMessage(entry, index);
                const finalText = messageText(entry);
                if (finalText) message.text = finalText;
              }
            }
            break;
          }
          case 'response.failed':
            throw failure(event.response ?? event, 'Chat response failed.');
          case 'response.incomplete':
            throw failure(event.response ?? event, 'Chat response was incomplete.');
          case 'error':
            throw failure(event, 'Chat response returned an error.');
          default:
            break;
        }
      }
    };
    try {
      await readSseStream(response.body, consume, () => completed);
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      throw failure({}, error instanceof Error ? error.message : 'Chat stream failed.');
    }
    if (!completed) throw failure({}, 'Chat response stream ended before completion.');
    if (orderedCalls.some(call => !call.done)) throw failure({}, 'Chat response stream ended during a tool call.');
    const output: unknown[] = [];
    for (const entry of sequence) {
      if (entry.kind === 'text') {
        if (!entry.message.text) continue;
        output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: entry.message.text }] });
        if (!entry.message.streamed) await args.onText?.(entry.message.text);
      } else {
        output.push({ type: 'function_call', call_id: entry.call.id, name: entry.call.name, arguments: entry.call.arguments });
      }
    }
    return { output, calls: orderedCalls.map(({ id, name, arguments: callArguments }) => ({ id, name, arguments: callArguments })), usage, requestId };
  }
}
