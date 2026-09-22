import { log } from '../log';
import { authHeaders, proxied } from './client';
import { onToken } from './token';

export interface SseFrame {
  event: string;
  data: string;
}

export type LinkState = 'connected' | 'off';

export interface EventsHandle {
  close(): void;
}

/** Splits text into SSE frames; buffers a partial frame. */
export class SseParser {
  private buf = '';

  push(chunk: string): SseFrame[] {
    this.buf += chunk;
    const frames: SseFrame[] = [];
    let idx = this.buf.indexOf('\n\n');
    while (idx >= 0) {
      const frame = parseFrame(this.buf.slice(0, idx));
      if (frame) frames.push(frame);
      this.buf = this.buf.slice(idx + 2);
      idx = this.buf.indexOf('\n\n');
    }
    return frames;
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = 'message';
  const data: string[] = [];
  for (const line of raw.split('\n')) {
    if (line === '' || line.startsWith(':')) continue;
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    const value = i < 0 ? '' : line.slice(i + 1).replace(/^ /, '');
    if (field === 'event') event = value;
    else if (field === 'data') data.push(value);
  }
  return data.length > 0 ? { event, data: data.join('\n') } : null;
}

const BACKOFF_MS = [1000, 2000, 5000, 10000, 30000];

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** One /api/events stream with the Bearer; retries with backoff. */
export function openEvents(
  onFrame: (f: SseFrame) => void,
  onState: (s: LinkState) => void,
  fetchImpl: FetchLike = (i, init) => fetch(i, init),
): EventsHandle {
  let closed = false;
  let attempt = 0;
  let ctrl: AbortController | null = null;

  async function connectOnce(): Promise<void> {
    ctrl = new AbortController();
    const headers: Record<string, string> = {};
    Object.assign(headers, authHeaders());
    const r = await fetchImpl(proxied('/api/events'), { headers, signal: ctrl.signal });
    if (!r.ok || !r.body) throw new Error(`events ${r.status}`);
    onState('connected');
    attempt = 0;
    log.info('events', 'connected');
    await pump(r.body, onFrame);
  }

  async function run(): Promise<void> {
    while (!closed) {
      try {
        await connectOnce();
      } catch (e) {
        if (!closed) log.warn('events', 'stream dropped', { error: String(e) });
      }
      onState('off');
      if (closed) return;
      const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
      attempt += 1;
      await new Promise((res) => setTimeout(res, wait));
    }
  }

  // A portal token refresh must reopen the stream with the new bearer.
  const offToken = onToken(() => ctrl?.abort());
  void run();
  return {
    close(): void {
      closed = true;
      offToken();
      ctrl?.abort();
    },
  };
}

async function pump(
  body: ReadableStream<Uint8Array>,
  onFrame: (f: SseFrame) => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  const parser = new SseParser();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    for (const f of parser.push(dec.decode(value, { stream: true }))) onFrame(f);
  }
}
