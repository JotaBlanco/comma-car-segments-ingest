import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { dragTarget, loadDragMode, storeDragMode } from './drag';

let stored: Record<string, string> = {};

beforeEach(() => {
  stored = {};
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => stored[k] ?? null,
    setItem: (k: string, v: string) => {
      stored[k] = v;
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('dragTarget', () => {
  it('follows the chosen mode and flips it while shift is held', () => {
    expect(dragTarget('zoom', false)).toBe('zoom');
    expect(dragTarget('zoom', true)).toBe('select');
    expect(dragTarget('select', false)).toBe('select');
    expect(dragTarget('select', true)).toBe('zoom');
  });
});

describe('drag mode storage', () => {
  it('defaults to zoom and ignores junk', () => {
    expect(loadDragMode()).toBe('zoom');
    stored['fts.drag'] = 'lasso';
    expect(loadDragMode()).toBe('zoom');
  });
  it('round-trips the choice', () => {
    storeDragMode('select');
    expect(loadDragMode()).toBe('select');
  });
});
