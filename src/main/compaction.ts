// Mid-turn context compaction over the Responses-format provider history.
// Tier 1 clears old tool outputs (the ledger keeps them for recall_tool_output);
// tier 2 replaces older items with a readable summary. Pure functions only.

/** Compact when the calibrated context estimate reaches this share of the window. */
export const COMPACT_AT = 0.70;
/** After clearing outputs, summarize if the context is still above this share. */
export const SUMMARIZE_ABOVE = 0.55;
/** Share of the window, newest first, whose tool outputs stay intact. */
export const KEEP_RECENT = 0.15;
/** Share of the window kept verbatim after the summary. */
export const SUMMARY_TAIL = 0.10;
/** Summarize only when the older history is at least this share of the window; smaller heads do not shrink. */
export const SUMMARY_MIN_HEAD = 0.15;
/** Largest share of the window the summary request itself may use. */
export const SUMMARY_INPUT = 0.60;

const MASK_MIN_CHARS = 600;
const MASKED_PREFIX = '{"cleared":';
const SUMMARY_PREFIX = '[Earlier conversation compacted]';
const TRANSCRIPT_PART = 1_000;

type Item = Record<string, unknown>;
const asItem = (value: unknown): Item => (value && typeof value === 'object' ? value as Item : {});
const isAssistantItem = (item: Item) => item.type === 'function_call' || (item.type === 'message' && item.role !== 'user');
const isUserMessage = (item: Item) => item.role === 'user' && Array.isArray(item.content);

function userText(item: Item): string {
  return (item.content as { type?: string; text?: string }[]).map(part => part.type === 'input_text' && typeof part.text === 'string' ? part.text : part.type ? `[${part.type}]` : '').join('');
}
function assistantText(item: Item): string {
  return Array.isArray(item.content) ? (item.content as { text?: string; refusal?: string }[]).map(part => part.text ?? part.refusal ?? '').join('') : '';
}
function clip(text: string, part = TRANSCRIPT_PART): string {
  return text.length > part * 2 ? `${text.slice(0, part)}\n…[${(text.length - part * 2).toLocaleString()} chars omitted]…\n${text.slice(-part)}` : text;
}

const roundStartAt = (input: unknown[], index: number) => isAssistantItem(asItem(input[index])) && (index === 0 || !isAssistantItem(asItem(input[index - 1])));

/** Index where the newest `tokens` worth of items begins, never after the start of the latest assistant round. */
function recentStart(input: unknown[], measure: (item: unknown) => number, tokens: number): number {
  let latestRound = input.length;
  for (let index = input.length - 1; index >= 0; index--) if (roundStartAt(input, index)) { latestRound = index; break; }
  let total = 0;
  for (let index = input.length - 1; index >= 0; index--) {
    total += measure(input[index]);
    if (total >= tokens) return Math.min(index, latestRound);
  }
  return 0;
}

/** Replaces older large tool outputs with a recall stub. Calls and arguments stay, so every call keeps its output. */
export function maskObservations(input: unknown[], measure: (item: unknown) => number, keepTokens: number): number {
  const protectFrom = recentStart(input, measure, keepTokens);
  let cleared = 0;
  for (let index = 0; index < protectFrom; index++) {
    const item = asItem(input[index]);
    if (item.type !== 'function_call_output' || typeof item.output !== 'string') continue;
    if (item.output.length < MASK_MIN_CHARS || item.output.startsWith(MASKED_PREFIX)) continue;
    input[index] = { ...item, output: JSON.stringify({ cleared: 'Output removed to save context. Call recall_tool_output with this callId to read it again.', chars: item.output.length, callId: item.call_id }) };
    cleared++;
  }
  return cleared;
}

/**
 * Splits history so the verbatim tail starts at the beginning of an assistant round.
 * A round's outputs always follow its calls, so no output in the tail loses its call,
 * and the tail follows the summary's user message with an assistant item.
 */
export function splitForSummary(input: unknown[], measure: (item: unknown) => number, tailTokens: number): { head: unknown[]; tail: unknown[] } {
  let start = recentStart(input, measure, tailTokens);
  while (start < input.length && !roundStartAt(input, start)) start++;
  return { head: input.slice(0, start), tail: input.slice(start) };
}

/** Plain-text rendering of history for a tool-free summary request that any provider accepts. */
export function transcriptText(items: unknown[]): string {
  const lines: string[] = [];
  for (const raw of items) {
    const item = asItem(raw);
    if (isUserMessage(item)) {
      const text = userText(item);
      lines.push(text.startsWith(SUMMARY_PREFIX) ? `Earlier summary:\n${text.slice(SUMMARY_PREFIX.length).trim()}` : `User: ${text}`);
    } else if (item.type === 'message') lines.push(`Assistant: ${assistantText(item)}`);
    else if (item.type === 'function_call') lines.push(`Tool call ${String(item.name)} [${String(item.call_id)}]: ${clip(String(item.arguments ?? ''), 500)}`);
    else if (item.type === 'function_call_output') lines.push(`Tool result [${String(item.call_id)}]: ${clip(typeof item.output === 'string' ? item.output : JSON.stringify(item.output ?? null))}`);
  }
  return lines.join('\n\n');
}

export const SUMMARY_INSTRUCTIONS = `You summarize a partial transcript between a user and Shellmate's assistant, which operates the user's terminals and remote machines. The summary replaces the transcript in the assistant's context so it can continue the current task without it; the user will also read it.
Write concise Markdown with these sections, omitting empty ones:
- Goal: what the user wants overall and what they asked most recently.
- Connections: each connection used (name and connectionId), whether it is connected, working directory, and any command still running.
- Work done: commands run with their key results, errors, and exit codes, in order.
- Changes made: every change to a machine (files, services, packages, configuration, notes), so the user can review them.
- Findings: facts learned about the systems that matter for the task.
- Open items: pending questions, approvals, or decisions, and the next steps.
Keep tool call IDs for results the assistant may need to reread with recall_tool_output. Record only what the transcript shows; never invent results. Do not include passwords, keys, tokens, or other secrets.`;

export function summaryRequest(transcript: string): unknown[] {
  return [{ role: 'user', content: [{ type: 'input_text', text: `Transcript to summarize:\n\n${transcript}\n\nWrite the summary now.` }] }];
}

/** The last user message item, which holds the request the running turn is working on. */
export function latestUserIndex(input: unknown[]): number {
  for (let index = input.length - 1; index >= 0; index--) {
    const item = asItem(input[index]);
    if (isUserMessage(item) && !userText(item).startsWith(SUMMARY_PREFIX)) return index;
  }
  return -1;
}

/** Summary message followed by the verbatim tail. Quotes the current request when the tail no longer holds it. */
export function compactedHistory(summary: string, request: unknown, tail: unknown[]): unknown[] {
  const quoted = request && !tail.includes(request) ? `\n\nCurrent user request (verbatim):\n${userText(asItem(request))}` : '';
  return [{ role: 'user', content: [{ type: 'input_text', text: `${SUMMARY_PREFIX}\n${summary.trim()}${quoted}` }] }, ...tail];
}

/** Assistant text from a provider round's Responses-format output. */
export function outputText(output: unknown[]): string {
  return output.map(asItem).filter(item => item.type === 'message').map(assistantText).join('').trim();
}

/** Provider-reported prompt tokens from Responses, Chat Completions, or Anthropic usage. */
export function reportedInputTokens(usage: unknown): number | null {
  const value = asItem(usage);
  const number = (key: string) => typeof value[key] === 'number' ? value[key] as number : 0;
  // Anthropic reports cached prompt tokens separately from input_tokens.
  const total = (number('input_tokens') || number('prompt_tokens')) + number('cache_read_input_tokens') + number('cache_creation_input_tokens');
  return total > 0 ? total : null;
}
