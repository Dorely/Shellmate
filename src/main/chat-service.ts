import { ContextTokenCounter } from './chat-context';
import { tools, instructions } from './assistant';
import { CHAT_MODELS } from '../shared/chat-models';
import { ChatCompletionsClient, toChatMessages, toResponsesOutput } from './providers/generic/chat';
import { GenericResponsesClient } from './providers/generic/responses';
import { AnthropicClient } from './providers/generic/anthropic';
import { CodexClient } from './providers/codex';
import type { CodexAuth } from './providers/auth';
import type { ChatRegistry, ResolvedChatTarget } from './chat-registry';
import type { DiagnosticLog } from './diagnostics';
import { redactText } from './diagnostics';
import type { Store } from './store';
import type { TerminalManager } from './terminal';
import type { AccessMode, ApprovalRequest } from '../shared/types';
import { randomUUID } from 'node:crypto';

type Turn = { controller: AbortController; targets: Map<string, AccessMode> };
type PendingApproval = { request: ApprovalRequest; resolve: (allow: boolean) => void };
const bounded = (value: string, length = 5_000) => value.length > length ? value.slice(-length) : value;

export class ChatService {
  private counter = new ContextTokenCounter();
  private turns = new Map<string, Turn>();
  private turnTasks = new Set<Promise<void>>();
  private pending = new Map<string, PendingApproval>();
  private live = new Map<string, { input: unknown[]; text: string; instructions: string; tools: unknown[]; model: string }>();
  private codex = new CodexClient();
  private shuttingDown = false;
  constructor(private store: Store, private terminal: TerminalManager, private registry: ChatRegistry, private auth: CodexAuth, private changed: () => void, private diagnostics: DiagnosticLog) {}
  activeTurns(): string[] { return [...this.turns.keys()]; }
  approvals(): ApprovalRequest[] { return [...this.pending.values()].map(item => item.request); }
  restrictWorkspaceAccess(workspaceId: string, connectionId: string, access: AccessMode | null): void {
    for (const [conversationId, turn] of this.turns) {
      if (this.store.conversation(conversationId).workspaceId !== workspaceId) continue;
      const previous = turn.targets.get(connectionId);
      if (access === null || access === 'disabled') turn.targets.delete(connectionId);
      else if (access === 'ask' && previous === 'autonomous') turn.targets.set(connectionId, 'ask');
    }
  }
  private targetInfo(conversationId: string, frozen?: Turn) {
    const conversation = this.store.conversation(conversationId);
    const targets = (frozen ? [...frozen.targets].map(([connectionId, access]) => ({ connectionId, access })) : this.store.workspaceConnections(conversation.workspaceId))
      .filter(target => target.access !== 'disabled' && this.store.workspaceAccess(conversation.workspaceId, target.connectionId) !== 'disabled')
      .filter(target => this.store.hasWorkspaceConnection(conversation.workspaceId, target.connectionId));
    return targets.map(target => ({ id: target.connectionId, name: this.store.connection(target.connectionId).name, access: target.access,
      connected: Boolean(this.terminal.session(conversation.workspaceId, target.connectionId)), notes: this.store.notes(target.connectionId).map(note => note.title) }));
  }
  private chatInstructions(conversationId: string, frozen?: Turn) {
    const conversation = this.store.conversation(conversationId);
    return instructions({ workspace: this.store.workspace(conversation.workspaceId).name, conversation: conversation.title, targets: this.targetInfo(conversationId, frozen) });
  }
  private history(conversationId: string): unknown[] {
    const raw = this.store.setting(`history/${conversationId}`, '[]');
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('Conversation history is invalid.');
    const seen = new Set<string>();
    for (const item of parsed) if (item && typeof item === 'object' && (item as { type?: string }).type === 'function_call_output') seen.add(String((item as { call_id?: string }).call_id));
    for (const item of parsed) if (item && typeof item === 'object' && (item as { type?: string }).type === 'function_call') {
      const id = String((item as { call_id?: string }).call_id);
      if (!seen.has(id)) { const ledger = this.store.toolCall(id); if (!ledger) throw new Error('Conversation tool history is incomplete.'); parsed.push({ type: 'function_call_output', call_id: id, output: ledger.result ?? JSON.stringify({ error: 'Tool outcome uncertain after interruption; not replayed.' }) }); seen.add(id); }
    }
    this.store.setSetting(`history/${conversationId}`, JSON.stringify(parsed));
    return parsed;
  }
  chatContext(conversationId: string, draft: string) {
    const live = this.live.get(conversationId);
    const selection = this.registry.activeSelection();
    const model = live?.model ?? selection.modelId.replace(/^codex:/, '');
    const entry = CHAT_MODELS.find(item => item.id === model);
    return { model, limit: entry?.contextLimit ?? null, ...this.counter.count({ instructions: live?.instructions ?? this.chatInstructions(conversationId), tools: live?.tools ?? tools as unknown as unknown[], input: live?.input ?? this.history(conversationId), draft, streamingText: live?.text }) };
  }
  async sendMessage(conversationId: string, text: string) {
    if (this.shuttingDown) throw new Error('Shellmate is closing.');
    if (!text.trim() || text.length > 50_000) throw new Error('Message must contain 1–50,000 characters.');
    this.store.conversation(conversationId);
    if (this.turns.has(conversationId)) throw new Error('A response is already running.');
    const target = await this.registry.resolveActive();
    const workspaceId = this.store.conversation(conversationId).workspaceId;
    const turn: Turn = { controller: new AbortController(), targets: new Map(this.store.workspaceConnections(workspaceId).map(item => [item.connectionId, item.access])) };
    this.turns.set(conversationId, turn);
    this.store.titleConversation(conversationId, text); this.store.addMessage(conversationId, 'user', text.trim()); this.store.setTurn(conversationId, 'running');
    const task = this.runTurn(conversationId, text.trim(), target, turn).finally(() => {
      this.turns.delete(conversationId); this.terminal.finishTurn(conversationId);
      for (const [id, item] of this.pending) if (item.request.conversationId === conversationId) { this.pending.delete(id); item.resolve(false); }
      this.turnTasks.delete(task);
      this.changed();
    });
    this.turnTasks.add(task);
  }
  cancelTurn(conversationId: string) {
    this.turns.get(conversationId)?.controller.abort();
    for (const [id, item] of this.pending) if (item.request.conversationId === conversationId) { this.pending.delete(id); item.resolve(false); }
    this.changed();
  }
  resolveApproval(id: string, allow: boolean) {
    const item = this.pending.get(id); if (!item) throw new Error('Approval expired.');
    this.pending.delete(id); item.resolve(allow); this.changed();
  }
  private async stream(target: ResolvedChatTarget, args: { input: unknown[]; instructions: string; signal: AbortSignal; onText: (text: string) => void }) {
    const availableTools = tools as unknown as unknown[];
    const system = args.instructions;
    const signal = AbortSignal.any([args.signal, AbortSignal.timeout(180_000)]);
    if (target.kind === 'codex') return this.codex.streamChat({ model: target.slug, input: args.input, instructions: system, tools: availableTools, effort: target.effort, token: await this.auth.getAccessToken(), signal, onText: args.onText });
    const key = target.provider ? await this.registry.providerKey(target.provider.id) : null;
    if (target.kind === 'anthropic') return new AnthropicClient({ baseUrl: target.provider!.baseUrl, apiKey: key }).streamChat({ model: target.slug, input: args.input, instructions: system, tools: availableTools, maxTokens: target.record?.maxTokens ?? 8192, signal, onText: args.onText });
    if (target.kind === 'responses') return new GenericResponsesClient({ baseUrl: target.provider!.baseUrl, apiKey: key }).streamChat({ model: target.slug, input: args.input, instructions: system, tools: availableTools, effort: target.effort || undefined, signal, onText: args.onText });
    const result = await new ChatCompletionsClient({ baseUrl: target.provider!.baseUrl, apiKey: key }).streamChat({ model: target.slug, messages: toChatMessages(args.input, system), tools: availableTools, effort: target.effort || undefined, signal, onText: args.onText });
    return { output: toResponsesOutput(result.text, result.calls), calls: result.calls, usage: result.usage, requestId: result.requestId };
  }
  private async runTurn(conversationId: string, text: string, target: ResolvedChatTarget, turn: Turn) {
    let message = this.store.addMessage(conversationId, 'assistant', '', 'running');
    let round = 0;
    try {
      const input = this.history(conversationId);
      input.push({ role: 'user', content: [{ type: 'input_text', text }] });
      this.store.setSetting(`history/${conversationId}`, JSON.stringify(input));
      const prompt = this.chatInstructions(conversationId, turn);
      const live = { input, text: '', instructions: prompt, tools: tools as unknown as unknown[], model: target.slug }; this.live.set(conversationId, live);
      for (; round < 30 && !turn.controller.signal.aborted; round++) {
        const response = await this.stream(target, { input, instructions: prompt, signal: turn.controller.signal, onText: chunk => { live.text += chunk; message.text += chunk; this.store.updateMessage(message); } });
        message.status = 'completed'; this.store.updateMessage(message); input.push(...response.output); live.text = '';
        this.store.setSetting(`history/${conversationId}`, JSON.stringify(input));
        for (const call of response.calls) {
          const result = turn.controller.signal.aborted ? JSON.stringify({ error: 'Turn cancelled before tool dispatch.' }) : await this.executeTool(conversationId, call, turn);
          input.push({ type: 'function_call_output', call_id: call.id, output: result });
          this.store.setSetting(`history/${conversationId}`, JSON.stringify(input));
        }
        if (!response.calls.length || turn.controller.signal.aborted) break;
        message = this.store.addMessage(conversationId, 'assistant', '', 'running');
      }
      if (round >= 30 && !turn.controller.signal.aborted) { message.text += '\nTool limit reached. Send another message to continue.'; message.status = 'completed'; this.store.updateMessage(message); }
      if (turn.controller.signal.aborted && message.status === 'running') { message.status = 'cancelled'; message.text += '\nResponse stopped.'; this.store.updateMessage(message); }
      this.store.setTurn(conversationId, turn.controller.signal.aborted ? 'cancelled' : 'completed');
    } catch (error) {
      message.status = turn.controller.signal.aborted ? 'cancelled' : 'failed';
      const safe = redactText(error instanceof Error ? error.message : 'Chat request failed.');
      message.text += `\n${turn.controller.signal.aborted ? 'Response stopped.' : safe}`;
      this.store.updateMessage(message); this.store.setTurn(conversationId, message.status);
      this.diagnostics.record('chat.failed', { conversationId, round, error: safe });
    } finally { this.live.delete(conversationId); }
  }
  private permitted(conversationId: string, connectionId: string, turn: Turn): AccessMode {
    const frozen = turn.targets.get(connectionId);
    const workspaceId = this.store.conversation(conversationId).workspaceId;
    const current = this.store.workspaceAccess(workspaceId, connectionId);
    if (!frozen || frozen === 'disabled' || !current || current === 'disabled' || !this.store.hasWorkspaceConnection(workspaceId, connectionId)) throw new Error('Connection is not available to this conversation.');
    return frozen === 'ask' || current === 'ask' ? 'ask' : 'autonomous';
  }
  private async approve(conversationId: string, connectionId: string, sessionId: string, command: string, turn: Turn): Promise<void> {
    const request: ApprovalRequest = { id: randomUUID(), conversationId, workspaceId: this.store.conversation(conversationId).workspaceId, connectionId, sessionId, command, createdAt: new Date().toISOString() };
    const allowed = await new Promise<boolean>(resolve => { this.pending.set(request.id, { request, resolve }); this.changed(); turn.controller.signal.addEventListener('abort', () => resolve(false), { once: true }); });
    this.pending.delete(request.id); this.changed();
    if (!allowed || turn.controller.signal.aborted) throw new Error('Command approval declined or cancelled.');
    if (this.terminal.session(request.workspaceId, connectionId)?.id !== sessionId) throw new Error('Session changed while awaiting approval.');
    this.permitted(conversationId, connectionId, turn);
  }
  private async executeTool(conversationId: string, call: { id: string; name: string; arguments: string }, turn: Turn): Promise<string> {
    const old = this.store.toolCall(call.id);
    if (old) { if (old.conversationId !== conversationId || old.name !== call.name || old.args !== call.arguments) throw new Error('Tool call ID conflict.'); return old.result ?? JSON.stringify({ error: 'Prior tool outcome uncertain; not replayed.' }); }
    this.store.startTool(call.id, conversationId, call.name, call.arguments);
    let connectionId: string | undefined;
    try {
      const data: unknown = JSON.parse(call.arguments);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid tool arguments.');
      const args = data as Record<string, unknown>;
      const string = (key: string) => { if (typeof args[key] !== 'string') throw new Error(`${key} is required.`); return args[key] as string; };
      const workspaceId = this.store.conversation(conversationId).workspaceId;
      const wantsConnection = call.name !== 'rename_session';
      if (wantsConnection) { connectionId = string('connectionId'); this.permitted(conversationId, connectionId, turn); }
      let result: unknown;
      switch (call.name) {
        case 'connect_terminal': {
          await this.terminal.connect(workspaceId, connectionId!);
          const s = this.terminal.acquire(workspaceId, connectionId!, conversationId);
          result = { ...this.terminal.snapshot(s), output: bounded(s.output) }; break;
        }
        case 'read_terminal_state': {
          const s = this.terminal.acquire(workspaceId, connectionId!, conversationId); result = { ...this.terminal.snapshot(s), output: bounded(s.output) }; break;
        }
        case 'run_shell_command': {
          const s = this.terminal.acquire(workspaceId, connectionId!, conversationId);
          const command = string('command');
          if (this.permitted(conversationId, connectionId!, turn) === 'ask') await this.approve(conversationId, connectionId!, s.id, command, turn);
          if (turn.controller.signal.aborted || s.owner?.conversationId !== conversationId) throw new Error('Terminal ownership changed.');
          this.store.addMessage(conversationId, 'tool', command, 'completed', connectionId, call.name);
          result = await this.terminal.execute(s, command, typeof args.timeoutSeconds === 'number' ? args.timeoutSeconds : 10, turn.controller.signal);
          this.store.addMessage(conversationId, 'tool', `${(result as { status: string }).status}: ${bounded(JSON.stringify(result), 2_000)}`, 'completed', connectionId, 'command_result');
          break;
        }
        case 'wait_for_terminal': {
          const s = this.terminal.acquire(workspaceId, connectionId!, conversationId);
          const seconds = Number(args.seconds);
          if (!Number.isInteger(seconds) || seconds < 1 || seconds > 30) throw new Error('Wait must be 1–30 seconds.');
          await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, seconds * 1000); turn.controller.signal.addEventListener('abort', () => { clearTimeout(timer); reject(new Error('Turn stopped.')); }, { once: true }); });
          result = { ...this.terminal.snapshot(s), output: bounded(s.output) }; break;
        }
        case 'list_connection_notes': result = this.store.notes(connectionId!).map(note => ({ id: note.id, title: note.title, updatedAt: note.updatedAt })); break;
        case 'read_connection_note': result = this.store.notes(connectionId!).find(note => note.title.toLowerCase() === string('title').toLowerCase()) ?? { error: 'Note not found.' }; break;
        case 'save_connection_note': {
          const title = string('title'); const content = string('content'); const current = this.store.notes(connectionId!).find(note => note.title.toLowerCase() === title.toLowerCase());
          result = this.store.saveNote(connectionId!, { id: current?.id, title, content }); break;
        }
        case 'delete_connection_note': {
          const current = this.store.notes(connectionId!).find(note => note.title.toLowerCase() === string('title').toLowerCase());
          if (!current) throw new Error('Note not found.'); this.store.deleteNote(connectionId!, current.id); result = { deleted: current.title }; break;
        }
        case 'rename_session': {
          const conversation = this.store.conversation(conversationId);
          if (conversation.titleSource === 'user') result = { unchanged: 'User title has priority.' };
          else { this.store.renameConversation(conversationId, string('title'), 'assistant'); result = { renamed: true }; }
          break;
        }
        default: throw new Error('Unknown assistant tool.');
      }
      const output = JSON.stringify(result);
      this.store.finishTool(call.id, output);
      if (call.name !== 'run_shell_command') this.store.addMessage(conversationId, 'tool', `${call.name}: ${bounded(output, 1_000)}`, 'completed', connectionId, call.name);
      return output;
    } catch (error) {
      const output = JSON.stringify({ error: redactText(error instanceof Error ? error.message : 'Tool failed.') });
      this.store.finishTool(call.id, output, 'failed');
      this.store.addMessage(conversationId, 'tool', `${call.name}: ${output}`, 'failed', connectionId, call.name);
      return output;
    }
  }
  async shutdown() { this.shuttingDown = true; for (const id of this.turns.keys()) this.cancelTurn(id); await Promise.allSettled([...this.turnTasks]); }
}
