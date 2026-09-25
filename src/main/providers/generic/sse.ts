export interface SseFrame {
  event?: string;
  data: string[];
}

export function splitFrames(buffer: string): { frames: SseFrame[]; rest: string } {
  const frames: SseFrame[] = [];
  let split: number;
  while ((split = buffer.search(/\r?\n\r?\n/)) >= 0) {
    const separator = buffer[split] === '\r' ? (buffer[split + 2] === '\r' ? 4 : 2) : 2;
    frames.push(parseFrame(buffer.slice(0, split)));
    buffer = buffer.slice(split + separator);
  }
  return { frames, rest: buffer };
}

function parseFrame(frame: string): SseFrame {
  let event: string | undefined;
  const data: string[] = [];
  for (const line of frame.split(/\r?\n/)) {
    if (line.startsWith('event:')) event = line.slice(6).trimStart();
    else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
  }
  return { event, data };
}

export function parseJsonPayload(text: string): unknown | undefined {
  if (text === '[DONE]') return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

export async function readSseStream(
  body: ReadableStream<Uint8Array>,
  consume: (frame: SseFrame) => Promise<void> | void,
  isComplete: () => boolean,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    while (!isComplete()) {
      const part = await reader.read();
      if (part.done) {
        buffer += decoder.decode();
        break;
      }
      buffer += decoder.decode(part.value, { stream: true });
      const parsed = splitFrames(buffer);
      buffer = parsed.rest;
      for (const frame of parsed.frames) {
        await consume(frame);
        if (isComplete()) break;
      }
    }
    if (!isComplete() && buffer.trim()) {
      const frame = parseFrame(buffer);
      if (frame.data.length) await consume(frame);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
