import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clampStripHeight,
  clearStoredStripHeight,
  loadStripHeight,
  storeStripHeight,
  STRIP_HEIGHT_DEFAULT,
  STRIP_HEIGHT_MAX,
  STRIP_HEIGHT_MIN,
} from './panelSizes';

function stubStorage(seed: Record<string, string> = {}): Record<string, string> {
  const store = { ...seed };
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => {
      store[k] = v;
    },
    removeItem: (k: string) => {
      delete store[k];
    },
  });
  return store;
}

describe('strip height', () => {
  beforeEach(() => stubStorage());
  afterEach(() => vi.unstubAllGlobals());

  it('clamps to the range', () => {
    expect(clampStripHeight(10)).toBe(STRIP_HEIGHT_MIN);
    expect(clampStripHeight(9999)).toBe(STRIP_HEIGHT_MAX);
    expect(clampStripHeight(200.4)).toBe(200);
  });

  it('round-trips through storage and falls back to the default', () => {
    expect(loadStripHeight()).toBe(STRIP_HEIGHT_DEFAULT);
    storeStripHeight(300);
    expect(loadStripHeight()).toBe(300);
    clearStoredStripHeight();
    expect(loadStripHeight()).toBe(STRIP_HEIGHT_DEFAULT);
  });

  it('survives a blocked storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadStripHeight()).toBe(STRIP_HEIGHT_DEFAULT);
    expect(() => storeStripHeight(300)).not.toThrow();
    expect(() => clearStoredStripHeight()).not.toThrow();
  });
});
