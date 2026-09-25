import { redactText } from '../diagnostics';
import { ProviderHttpError, ProviderResponseError } from './errors';
import { postWithEffortFallback } from './generic/chat';
import { DEFAULT_MODEL, resolveChatModel } from '../../shared/chat-models';
export { ProviderHttpError } from './errors';

const RESPONSES_ENDPOINT = 'https://chatgpt.com/backend-api/codex/responses';
const ORIGINATOR = 'codex_cli_rs';

export interface StreamChatInput { token: string; model?: string; input: unknown; instructions?: string; tools?: unknown[]; effort?: string; signal?: AbortSignal; onText?: (text: string) => void | Promise<void> }
export interface StreamChatResult { output: any[]; calls: { id: string; name: string; arguments: string }[]; usage?: unknown; requestId?: string | null }
export interface CodexClientOptions { fetch?: typeof globalThis.fetch; endpoint?: string }

function accountId(token: string): string {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Codex token is invalid.');
  try {
    const json = JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - parts[1].length % 4) % 4), 'base64').toString('utf8')) as Record<string, any>;
    const id = json['https://api.openai.com/auth']?.chatgpt_account_id;
    if (typeof id !== 'string' || !id) throw new Error();
    return id;
  } catch { throw new Error('Codex token is invalid.'); }
}

function eventFrames(buffer: string): { frames: string[]; rest: string } {
  const frames: string[] = [];
  let split: number;
  while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
    const separator = buffer[split] === '\r' ? (buffer[split + 2] === '\r' ? 4 : 2) : 2;
    frames.push(buffer.slice(0, split)); buffer = buffer.slice(split + separator);
  }
  return { frames, rest: buffer };
}
function parseFrame(frame: string): string | null {
  const lines = frame.split(/\r?\n/).filter(line => line.startsWith('data:'));
  if (!lines.length) return null;
  return lines.map(line => line.slice(5).replace(/^ /, '')).join('\n');
}
export class CodexClient {
  private readonly fetcher: typeof globalThis.fetch;
  private readonly endpoint: string;
  constructor(options: CodexClientOptions = {}) { this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis); this.endpoint = options.endpoint ?? RESPONSES_ENDPOINT; }

  async streamChat(args: StreamChatInput): Promise<StreamChatResult> {
    try { return await this.request(args); }
    catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      throw new Error(redactText(error instanceof Error ? error.message : 'Codex request failed.', [args.token]));
    }
  }

  private async request(args: StreamChatInput): Promise<StreamChatResult> {
    const buildBody = (effortFields: Record<string, unknown>): Record<string, unknown> => {
      const body: Record<string, unknown> = { model: resolveChatModel(args.model), stream: true, store: false, input: args.input, instructions: args.instructions ?? 'You are a helpful assistant.', ...effortFields };
      if (args.tools?.length) { body.tools = args.tools; body.tool_choice = 'auto'; }
      return body;
    };
    const headers = { authorization: `Bearer ${args.token}`, 'ChatGPT-Account-ID': accountId(args.token), 'OpenAI-Beta': 'responses=experimental', originator: ORIGINATOR, 'User-Agent': 'codex_cli_rs/0.0.0 (Shellmate)', accept: 'text/event-stream', 'content-type': 'application/json' };
    const response = await postWithEffortFallback({ kind: 'codex-account', effort: args.effort, fetchImpl: this.fetcher, url: this.endpoint, headers, buildBody, signal: args.signal, providerLabel: 'Codex', secrets: [args.token] });
    if (!response.ok) throw await ProviderHttpError.fromResponse(response, 'Codex', [args.token]);
    const requestId = response.headers.get('x-request-id') ?? response.headers.get('request-id');
    const streamFailure = (payload: any, fallback: string) => ProviderResponseError.fromPayload('Codex', { ...payload, message: payload?.message ?? fallback, request_id: requestId }, [args.token]);
    if (!response.body) throw new Error('Codex response did not include a stream.');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = ''; let completed = false; let usage: unknown; let responseOutput: any[] | undefined;
    const calls = new Map<string, { id: string; name: string; arguments: string; done: boolean }>();
    const orderedCalls: { id: string; name: string; arguments: string; done: boolean }[] = [];
    const messages = new Map<string, { text: string; streamed: boolean }>();
    const sequence: ({ kind: 'text'; message: { text: string; streamed: boolean } } | { kind: 'call'; call: { id: string; name: string; arguments: string; done: boolean } })[] = [];
    const upsertMessage = (item: any, outputIndex?: number) => {
      const id = typeof item?.id === 'string' ? item.id : typeof item?.item_id === 'string' ? item.item_id : undefined;
      const index = typeof outputIndex === 'number' ? `index:${outputIndex}` : undefined;
      let message = (id ? messages.get(id) : undefined) ?? (index ? messages.get(index) : undefined);
      // Some events omit both identifiers. Keep their deltas in a single fallback item.
      if (!id && !index) message = messages.get('unidentified');
      else if (!message && messages.has('unidentified')) { message = messages.get('unidentified'); messages.delete('unidentified'); }
      if (!message) { message = { text: '', streamed: false }; sequence.push({ kind: 'text', message }); }
      if (id) messages.set(id, message);
      if (index) messages.set(index, message);
      if (!id && !index) messages.set('unidentified', message);
      return message;
    };
    const upsertCall = (item: any): { id: string; name: string; arguments: string; done: boolean } | undefined => {
      const callId = typeof item?.call_id === 'string' ? item.call_id : (typeof item?.id === 'string' ? item.id : undefined);
      if (!callId) return undefined;
      const existing = (typeof item.call_id === 'string' ? calls.get(item.call_id) : undefined)
        ?? (typeof item.id === 'string' ? calls.get(item.id) : undefined);
      const call = existing ?? { id: callId, name: typeof item.name === 'string' ? item.name : '', arguments: '', done: false };
      if (!existing) { orderedCalls.push(call); sequence.push({ kind: 'call', call }); }
      if (typeof item.call_id === 'string') call.id = item.call_id;
      if (typeof item.name === 'string' && item.name) call.name = item.name;
      if (typeof item.call_id === 'string') calls.set(item.call_id, call);
      if (typeof item.id === 'string') calls.set(item.id, call);
      return call;
    };
    const output: any[] = [];
    const consume = async (data: string): Promise<void> => {
      if (data === '[DONE]') return;
      let event: any; try { event = JSON.parse(data); } catch { return; }
      switch (event.type) {
        case 'response.output_text.delta': {
          const delta = typeof event.delta === 'string' ? event.delta : '';
          if (delta) { const message = upsertMessage(event, event.output_index); message.text += delta; message.streamed = true; await args.onText?.(delta); }
          break;
        }
        case 'response.output_item.added': {
          const item = event.item; if (item?.type === 'function_call') {
            const call = upsertCall(item);
            if (call && typeof item.arguments === 'string') call.arguments = item.arguments;
          } else if (item?.type === 'message') upsertMessage(item, event.output_index);
          break;
        }
        case 'response.function_call_arguments.delta': { const id = event.call_id ?? event.item_id; const call = typeof id === 'string' ? calls.get(id) : undefined; if (call && typeof event.delta === 'string') call.arguments += event.delta; break; }
        case 'response.function_call_arguments.done': { const id = event.call_id ?? event.item_id; const call = typeof id === 'string' ? calls.get(id) : undefined; if (call) { if (typeof event.arguments === 'string') call.arguments = event.arguments; call.done = true; } break; }
        case 'response.output_item.done': {
          const item = event.item;
          if (item?.type === 'function_call') { const call = upsertCall(item); if (call) { if (typeof item.arguments === 'string') call.arguments = item.arguments; call.done = true; } }
          else if (item?.type === 'message') {
            const message = upsertMessage(item, event.output_index);
            const finalText = messageText(item);
            if (finalText) message.text = finalText;
          }
          break;
        }
        case 'response.completed': case 'response.done':
          if (event.status === 'failed' || event.response?.status === 'failed' || event.error || event.response?.error) throw streamFailure(event.response ?? event, 'Codex response failed.');
          if (['incomplete', 'cancelled'].includes(event.status ?? event.response?.status)) throw streamFailure(event.response ?? event, 'Codex response was incomplete.');
          completed = true;
          usage = event.response?.usage ?? event.usage;
          if (Array.isArray(event.response?.output)) responseOutput = event.response.output;
          for (const [index, item] of (responseOutput ?? []).entries()) {
            if (item?.type === 'function_call') {
              const call = upsertCall(item);
              if (call) { if (typeof item.arguments === 'string') call.arguments = item.arguments; call.done = true; }
            } else if (item?.type === 'message') {
              const message = upsertMessage(item, index);
              const finalText = messageText(item);
              if (finalText) message.text = finalText;
            }
          }
          break;
        case 'response.failed': throw streamFailure(event.response ?? event, 'Codex response failed.');
        case 'response.incomplete': throw streamFailure(event.response ?? event, 'Codex response was incomplete.');
        case 'error': throw streamFailure(event, 'Codex response returned an error.');
      }
    };
    try {
      while (!completed) {
        const part = await reader.read();
        if (part.done) { buffer += decoder.decode(); break; }
        buffer += decoder.decode(part.value, { stream: true });
        const parsed = eventFrames(buffer); buffer = parsed.rest;
        for (const frame of parsed.frames) {
          const data = parseFrame(frame); if (data !== null) await consume(data);
          if (completed) break;
        }
      }
      if (!completed) { const tail = parseFrame(buffer); if (tail !== null) await consume(tail); }
    } catch (error) {
      if (error instanceof ProviderHttpError) throw error;
      throw streamFailure({}, error instanceof Error ? error.message : 'Codex stream failed.');
    } finally {
      await reader.cancel().catch(() => undefined);
      reader.releaseLock();
    }
    if (!completed) throw streamFailure({}, 'Codex response stream ended before completion.');
    const finishedCalls = orderedCalls;
    if (finishedCalls.some(call => !call.done)) throw streamFailure({}, 'Codex response stream ended during a tool call.');
    // Terminal output can be empty or partial. Merge it with observed items;
    // replacing the stream loses function calls and produces orphan tool results.
    for (const entry of sequence) {
      if (entry.kind === 'text') {
        if (!entry.message.text) continue;
        output.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: entry.message.text }] });
        if (!entry.message.streamed) await args.onText?.(entry.message.text);
      } else output.push({ type: 'function_call', call_id: entry.call.id, name: entry.call.name, arguments: entry.call.arguments });
    }
    return { output, calls: finishedCalls.map(({ id, name, arguments: callArguments }) => ({ id, name, arguments: callArguments })), usage, requestId };
  }
}

function messageText(item: any): string {
  if (!Array.isArray(item?.content)) return '';
  return item.content.map((part: any) => part?.type === 'output_text' && typeof part.text === 'string' ? part.text : part?.type === 'refusal' && typeof part.refusal === 'string' ? part.refusal : '').join('');
}

export const streamChat = (args: StreamChatInput, options?: CodexClientOptions): Promise<StreamChatResult> => new CodexClient(options).streamChat(args);
export { RESPONSES_ENDPOINT, DEFAULT_MODEL };
