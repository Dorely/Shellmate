import { randomUUID } from 'node:crypto';
import type { Store } from './store';
import { secretName, type SecureStore } from './providers/secrets';
import type { ChatModelEntry } from '../shared/types';
import { CHAT_MODELS, DEFAULT_EFFORT, DEFAULT_MODEL } from '../shared/chat-models';
import {
  effortsKey,
  isProviderKind,
  normalizeBaseUrl,
  normalizeEfforts,
  normalizeSlug,
  parseModels,
  parseProviders,
  validateProviderFields,
  type ChatModelRecord,
  type ChatProvider,
} from './providers/generic/registry';
import { runCapabilityProbe, type CapabilityOutcome } from './providers/generic/capabilities';
import { AnthropicClient } from './providers/generic/anthropic';
import { ChatCompletionsClient } from './providers/generic/chat';
import { GenericResponsesClient } from './providers/generic/responses';

export interface ResolvedChatTarget {
  selectionId: string;
  modelLabel: string;
  providerLabel: string;
  slug: string;
  effort: string;
  kind: 'codex' | 'chat-completions' | 'responses' | 'anthropic';
  provider?: ChatProvider;
  record?: ChatModelRecord;
}

interface PendingTest {
  provider: ChatProvider;
  slug: string;
  efforts: string[];
  outcome: CapabilityOutcome;
  keyPresent: boolean;
  at: number;
}

const TEST_TTL_MS = 10 * 60 * 1000;

export class ChatRegistry {
  private pending = new Map<string, PendingTest>();
  constructor(private readonly store: Store, private readonly secrets: SecureStore, private readonly now: () => number = Date.now) {}

  providers(): ChatProvider[] {
    return parseProviders(this.store.setting('chat-providers', '[]'));
  }

  models(): ChatModelRecord[] {
    return parseModels(this.store.setting('chat-models', '[]'));
  }

  private writeProviders(providers: ChatProvider[]) {
    this.store.setSetting('chat-providers', JSON.stringify(providers));
  }

  private writeModels(models: ChatModelRecord[]) {
    this.store.setSetting('chat-models', JSON.stringify(models));
  }

  activeSelection(): { modelId: string; effort: string } {
    const fallback = { modelId: `codex:${DEFAULT_MODEL}`, effort: DEFAULT_EFFORT };
    const raw = this.store.setting('chat-active', '');
    if (!raw) return fallback;
    try {
      const parsed = JSON.parse(raw) as { modelId?: string; effort?: string };
      if (typeof parsed.modelId === 'string' && parsed.modelId) return { modelId: parsed.modelId, effort: typeof parsed.effort === 'string' ? parsed.effort : '' };
    } catch { return fallback; }
    return fallback;
  }

  async resolveActive(): Promise<ResolvedChatTarget> {
    const selection = this.activeSelection();
    const builtIn = CHAT_MODELS.find(entry => `codex:${entry.id}` === selection.modelId || entry.id === selection.modelId);
    if (builtIn) {
      const effort = selection.effort && (builtIn.efforts as readonly string[]).includes(selection.effort) ? selection.effort : DEFAULT_EFFORT;
      return { selectionId: `codex:${builtIn.id}`, modelLabel: builtIn.label, providerLabel: 'Codex', slug: builtIn.id, effort, kind: 'codex' };
    }
    const models = this.models();
    const record = models.find(entry => entry.id === selection.modelId);
    if (!record) throw new Error('Selected chat model is unavailable. Choose another model in Settings.');
    const provider = this.providers().find(entry => entry.id === record.providerId);
    if (!provider) throw new Error('The chat provider for the selected model is missing. Select another model.');
    const effort = selection.effort && record.efforts.includes(selection.effort) ? selection.effort : record.efforts[0] ?? '';
    return { selectionId: record.id, modelLabel: `${provider.label}:${record.slug}`, providerLabel: provider.label, slug: record.slug, effort, kind: provider.kind, provider, record };
  }

  options(): { id: string; label: string; providerLabel: string; slug: string; efforts: string[]; builtIn: boolean }[] {
    const entries: { id: string; label: string; providerLabel: string; slug: string; efforts: string[]; builtIn: boolean }[] = CHAT_MODELS.map(entry => ({ id: `codex:${entry.id}`, label: `Codex:${entry.id}`, providerLabel: 'Codex', slug: entry.id, efforts: [...entry.efforts], builtIn: true }));
    for (const model of this.models()) {
      const provider = this.providers().find(entry => entry.id === model.providerId);
      if (!provider) continue;
      entries.push({ id: model.id, label: `${provider.label}:${model.slug}`, providerLabel: provider.label, slug: model.slug, efforts: model.efforts, builtIn: false });
    }
    return entries;
  }

  async saveProvider(input: { id?: string; label: string; baseUrl: string; kind: unknown; apiKey?: string; keyAction?: 'keep' | 'replace' | 'remove' }): Promise<ChatProvider> {
    const fields = validateProviderFields(input.label, input.baseUrl, input.kind);
    const providers = this.providers();
    const id = input.id?.trim() || randomUUID();
    const existing = providers.findIndex(entry => entry.id === id);
    const provider: ChatProvider = { id, label: fields.label, baseUrl: fields.baseUrl, kind: fields.kind };
    if (existing >= 0) providers[existing] = provider;
    else providers.push(provider);
    const action = input.keyAction ?? (input.apiKey?.trim() ? 'replace' : 'keep');
    if (action === 'replace') {
      if (!input.apiKey?.trim()) throw new Error('Enter an API key to replace the saved key.');
      await this.secrets.set(secretName('chat-key', id), input.apiKey.trim());
    } else if (action === 'remove') {
      await this.secrets.delete(secretName('chat-key', id));
    }
    this.writeProviders(providers);
    return provider;
  }

  async deleteProvider(id: string): Promise<void> {
    const providers = this.providers().filter(entry => entry.id !== id);
    this.writeProviders(providers);
    this.writeModels(this.models().filter(entry => entry.providerId !== id));
    await this.secrets.delete(secretName('chat-key', id)).catch(() => undefined);
    const active = this.activeSelection();
    if (active.modelId === id || this.models().every(entry => entry.id !== active.modelId && !active.modelId.startsWith('codex:'))) {
      this.store.setSetting('chat-active', JSON.stringify({ modelId: `codex:${DEFAULT_MODEL}`, effort: DEFAULT_EFFORT }));
    }
  }

  async providerKey(providerId: string): Promise<string | null> {
    try {
      return await this.secrets.get(secretName('chat-key', providerId));
    } catch {
      return null;
    }
  }

  async listModels(providerId: string, fetchImpl?: typeof globalThis.fetch, signal?: AbortSignal): Promise<string[]> {
    const provider = this.providers().find(entry => entry.id === providerId);
    if (!provider) throw new Error('Chat provider not found.');
    const key = await this.providerKey(providerId);
    const baseUrl = normalizeBaseUrl(provider.baseUrl);
    if (provider.kind === 'anthropic') return new AnthropicClient({ fetch: fetchImpl, baseUrl, apiKey: key }).listModels(signal);
    if (provider.kind === 'responses') return new GenericResponsesClient({ fetch: fetchImpl, baseUrl, apiKey: key }).listModels(signal);
    return new ChatCompletionsClient({ fetch: fetchImpl, baseUrl, apiKey: key }).listModels(signal);
  }

  async testModel(input: { providerId: string; slug: string; efforts: string[] }, fetchImpl?: typeof globalThis.fetch, signal?: AbortSignal): Promise<CapabilityOutcome> {
    const provider = this.providers().find(entry => entry.id === input.providerId);
    if (!provider) throw new Error('Chat provider not found.');
    if (!isProviderKind(provider.kind)) throw new Error('Chat provider type is invalid.');
    const slug = normalizeSlug(input.slug);
    const efforts = normalizeEfforts(input.efforts);
    const key = await this.providerKey(input.providerId);
    const outcome = await runCapabilityProbe({ provider: { ...provider, baseUrl: normalizeBaseUrl(provider.baseUrl) }, slug, efforts, apiKey: key, fetch: fetchImpl, signal });
    this.pending.set(this.pendingKey(provider, slug, efforts), { provider, slug, efforts, outcome, keyPresent: Boolean(key?.trim()), at: this.now() });
    return outcome;
  }

  async saveModel(input: { id?: string; providerId: string; slug: string; efforts: string[] }): Promise<ChatModelEntry> {
    const provider = this.providers().find(entry => entry.id === input.providerId);
    if (!provider) throw new Error('Chat provider not found.');
    const slug = normalizeSlug(input.slug);
    const efforts = normalizeEfforts(input.efforts);
    const key = await this.providerKey(input.providerId);
    const pending = this.pending.get(this.pendingKey(provider, slug, efforts));
    if (!pending || this.now() - pending.at > TEST_TTL_MS || pending.keyPresent !== Boolean(key?.trim()) || pending.outcome.failedEfforts.length) {
      throw new Error('Test this provider, model, and every effort before saving. A passing test is required.');
    }
    const models = this.models();
    const id = input.id?.trim() || randomUUID();
    const record: ChatModelRecord = {
      id,
      providerId: provider.id,
      slug,
      efforts,
      maxTokens: pending.outcome.maxTokens,
      vision: pending.outcome.vision,
      audio: pending.outcome.audio,
      effortResults: pending.outcome.perEffort,
      lastTestedAt: new Date(this.now()).toISOString(),
      ...(pending.outcome.error ? { testError: pending.outcome.error } : {}),
    };
    const existing = models.findIndex(entry => entry.id === id);
    if (existing >= 0) models[existing] = record;
    else models.push(record);
    this.writeModels(models);
    return record;
  }

  async deleteModel(id: string): Promise<void> {
    this.writeModels(this.models().filter(entry => entry.id !== id));
    const active = this.activeSelection();
    if (active.modelId === id) this.store.setSetting('chat-active', JSON.stringify({ modelId: `codex:${DEFAULT_MODEL}`, effort: DEFAULT_EFFORT }));
  }

  setActive(modelId: string, effort: string): { modelId: string; effort: string } {
    const option = this.options().find(entry => entry.id === modelId);
    if (!option) throw new Error('Chat model is not available. Add and test it in Settings first.');
    const trimmed = effort.trim();
    if (option.efforts.length) {
      const resolved = trimmed && option.efforts.includes(trimmed) ? trimmed : option.efforts[0]!;
      this.store.setSetting('chat-active', JSON.stringify({ modelId, effort: resolved }));
      return { modelId, effort: resolved };
    }
    this.store.setSetting('chat-active', JSON.stringify({ modelId, effort: '' }));
    return { modelId, effort: '' };
  }

  private pendingKey(provider: ChatProvider, slug: string, efforts: string[]): string {
    return `${provider.id}|${normalizeBaseUrl(provider.baseUrl)}|${provider.kind}|${slug}|${effortsKey(efforts)}`;
  }
}
