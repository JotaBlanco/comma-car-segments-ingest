import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./token', () => ({
  getToken: () => 'tok',
  onToken: () => () => {},
}));

import { openEvents, SseParser } from './events';

describe('SseParser', () => {
  it('yields one frame per blank-line terminated block', () => {
    const p = new SseParser();
    const frames = p.push('event: show_traces\ndata: {"a":1}\n\nevent: x\ndata: 2\n\n');
    expect(frames).toEqual([
      { event: 'show_traces', data: '{"a":1}' },
      { event: 'x', data: '2' },
    ]);
  });
  it('holds a partial frame across chunks', () => {
    const p = new SseParser();
    expect(p.push('event: show_traces\nda')).toEqual([]);
    expect(p.push('ta: {"a":1}\n\n')).toEqual([{ event: 'show_traces', data: '{"a":1}' }]);
  });
  it('ignores comments and defaults the event name', () => {
    const p = new SseParser();
    expect(p.push(': connected\n\n: keep-alive\n\ndata: hi\n\n')).toEqual([
      { event: 'message', data: 'hi' },
    ]);
  });
});

describe('openEvents', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('sends the bearer, reports connected and delivers frames', async () => {
    const seen: string[] = [];
    const headers: Record<string, string>[] = [];
    let release: () => void = () => {};
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(new TextEncoder().encode('event: show_traces\ndata: {"run_id":"r"}\n\n'));
        release = () => c.close();
      },
    });
    const fetchImpl = vi.fn((_: string, init: RequestInit) => {
      headers.push(init.headers as Record<string, string>);
      return Promise.resolve({ ok: true, status: 200, body } as Response);
    });
    const states: string[] = [];

    const h = openEvents(
      (f) => seen.push(f.data),
      (s) => states.push(s),
      fetchImpl,
    );
    await vi.waitFor(() => expect(seen).toEqual(['{"run_id":"r"}']));

    expect(headers[0].Authorization).toBe('Bearer tok');
    expect(states).toEqual(['connected']);
    h.close();
    release();
    await vi.waitFor(() => expect(states.at(-1)).toBe('off'));
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('reports off and does not retry after close on a failed connect', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve({ ok: false, status: 401, body: null } as Response),
    );
    const states: string[] = [];
    const h = openEvents(
      () => {},
      (s) => states.push(s),
      fetchImpl,
    );
    await vi.waitFor(() => expect(states).toEqual(['off']));
    h.close();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
