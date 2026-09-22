import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeThrottle } from './throttle';

let now = 0;

function stubNow(t: number): void {
  now = t;
  vi.stubGlobal('performance', { now: () => now });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('makeThrottle', () => {
  it('opens once per window of wall time', () => {
    stubNow(1000);
    const gate = makeThrottle(500);
    expect(gate()).toBe(true);
    now = 1499;
    expect(gate()).toBe(false);
    now = 1500;
    expect(gate()).toBe(true);
    now = 1999;
    expect(gate()).toBe(false);
    now = 2000;
    expect(gate()).toBe(true);
  });

  it('gives each gate its own window', () => {
    stubNow(0);
    const a = makeThrottle(500);
    const b = makeThrottle(500);
    expect(a()).toBe(true);
    expect(b()).toBe(true);
    now = 100;
    expect(a()).toBe(false);
    expect(b()).toBe(false);
  });
});
