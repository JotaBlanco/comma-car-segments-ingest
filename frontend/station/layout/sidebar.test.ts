import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadTreeOpen, loadTreeWidth, storeTreeOpen, storeTreeWidth } from './sidebar';

afterEach(() => vi.unstubAllGlobals());

describe('tree open persistence', () => {
  it('defaults to open when nothing is stored', () => {
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
    expect(loadTreeOpen()).toBe(true);
  });

  it('reads back a stored closed state', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
    storeTreeOpen(false);
    expect(loadTreeOpen()).toBe(false);
    storeTreeOpen(true);
    expect(loadTreeOpen()).toBe(true);
  });

  it('defaults to open when storage throws', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    expect(loadTreeOpen()).toBe(true);
    expect(() => storeTreeOpen(false)).not.toThrow();
  });
});

describe('tree width persistence', () => {
  it('defaults to 300 and clamps stored values into 220..480', () => {
    const store: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
    });
    expect(loadTreeWidth()).toBe(300);
    storeTreeWidth(900);
    expect(loadTreeWidth()).toBe(480);
    storeTreeWidth(10);
    expect(loadTreeWidth()).toBe(220);
    storeTreeWidth(333);
    expect(loadTreeWidth()).toBe(333);
  });

  it('ignores garbage in storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => 'wide', setItem: () => {} });
    expect(loadTreeWidth()).toBe(300);
  });
});
