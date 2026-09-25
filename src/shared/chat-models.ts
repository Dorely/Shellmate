// Codex account defaults, not API maxima. Evidence/date: docs/research/chat-context.md.
// Built-in entries carry the effort lists the Codex Responses backend accepts as
// reasoning.effort values (PixelChat OpenAIModelCatalog precedent: low, medium,
// high, xhigh, max). Generic entries resolve to unknown context limits.
export const DEFAULT_MODEL = 'gpt-5.6-sol';
export const DEFAULT_EFFORT = 'medium';
export const CODEX_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const CHAT_MODELS = [
  { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna', contextLimit: 272_000, efforts: [...CODEX_EFFORTS] },
  { id: 'gpt-5.6-sol', label: 'GPT-5.6 Sol', contextLimit: 272_000, efforts: [...CODEX_EFFORTS] },
  { id: 'gpt-6-astra', label: 'GPT-6 Astra', contextLimit: 272_000, efforts: [...CODEX_EFFORTS] },
  { id: 'gpt-6-luna', label: 'GPT-6 Luna', contextLimit: 272_000, efforts: [...CODEX_EFFORTS] },
  { id: 'gpt-6-sol', label: 'GPT-6 Sol', contextLimit: 272_000, efforts: [...CODEX_EFFORTS] }
] as const;

export function resolveChatModel(model?: string): string {
  if (!model?.trim() || model === 'backend default') return DEFAULT_MODEL;
  // Repair the former picker value in existing profiles.
  return model === 'gpt-5.6-astra' ? 'gpt-6-astra' : model;
}
