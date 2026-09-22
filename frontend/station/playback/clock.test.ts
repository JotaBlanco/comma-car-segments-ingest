import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlaybackClock } from './clock';

let now = 0;
let rafCb: ((t: number) => void) | null = null;

beforeEach(() => {
  now = 0;
  vi.stubGlobal('performance', { now: () => now });
  vi.stubGlobal('requestAnimationFrame', (cb: (t: number) => void) => {
    rafCb = cb;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', () => {
    rafCb = null;
  });
});
afterEach(() => vi.unstubAllGlobals());

function tick(ms: number) {
  now += ms;
  const cb = rafCb;
  rafCb = null;
  cb?.(now);
}

describe('PlaybackClock', () => {
  it('advances by wall time times speed and notifies subscribers', () => {
    const c = new PlaybackClock();
    c.load([{ t0: 1000, t1: 5000 }]);
    const seen: number[] = [];
    c.subscribe((t) => seen.push(t));
    c.setSpeed(2);
    c.play();
    tick(100);
    expect(c.t).toBe(1200);
    expect(seen.at(-1)).toBe(1200);
  });
  it('jumps gaps and pauses at the end', () => {
    const c = new PlaybackClock();
    c.load([
      { t0: 0, t1: 100 },
      { t0: 500, t1: 600 },
    ]);
    c.play();
    tick(150);
    expect(c.t).toBe(500);
    tick(200);
    expect(c.t).toBe(600);
    expect(c.playing).toBe(false);
  });
  it('seek clamps into segments and stop returns to start', () => {
    const c = new PlaybackClock();
    c.load([{ t0: 1000, t1: 2000 }]);
    c.seek(5000);
    expect(c.t).toBe(2000);
    c.stop();
    expect(c.t).toBe(1000);
  });
});
