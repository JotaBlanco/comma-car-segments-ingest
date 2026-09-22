import { describe, expect, it } from 'vitest';
import type { Catalog } from '../api/types';
import { findRecording, readEntryParams } from './params';

describe('entry params', () => {
  it('reads the run a caller names', () => {
    const p = readEntryParams('?run=sn003_20260605T071847258Z');
    expect(p).toEqual({ run: 'sn003_20260605T071847258Z', signals: [] });
  });

  it('collects every signal the caller repeats', () => {
    const p = readEntryParams('?run=r1&signal=pitch_angle&signal=roll_angle');
    expect(p?.signals).toEqual(['pitch_angle', 'roll_angle']);
  });

  it('reads the playhead and the marked period', () => {
    const p = readEntryParams('?run=r1&t=1780645772980&sel=1780645772980,1780645812975');
    expect(p?.t).toBe(1780645772980);
    expect(p?.sel).toEqual([1780645772980, 1780645812975]);
  });

  it('answers null when no run is named', () => {
    expect(readEntryParams('?signal=pitch_angle')).toBeNull();
    expect(readEntryParams('')).toBeNull();
  });

  it('drops a malformed time and period but keeps the run', () => {
    const p = readEntryParams('?run=r1&t=soon&sel=9,1');
    expect(p).toEqual({ run: 'r1', signals: [] });
  });
});

describe('finding the run in the catalog', () => {
  const catalog: Catalog = {
    aircraft: [
      {
        id: 'sn003',
        recordings: [
          { id: '20260605T071847258Z', run_id: 'sn003_20260605T071847258Z', tables: ['a429'] },
          { id: 'hand-named', run_id: 'hand-named', tables: ['a429'] },
        ],
      },
    ],
  };

  it('matches a recording by its run id', () => {
    expect(findRecording(catalog, 'sn003_20260605T071847258Z')).toEqual({
      a: 'sn003',
      r: '20260605T071847258Z',
    });
  });

  it('matches a run someone named by hand', () => {
    expect(findRecording(catalog, 'hand-named')).toEqual({ a: 'sn003', r: 'hand-named' });
  });

  it('answers null for a run the lake does not hold', () => {
    expect(findRecording(catalog, 'gone')).toBeNull();
  });
});

describe('the issue a link names', () => {
  it('reads a positive snippet id and drops anything else', () => {
    expect(readEntryParams('?run=r&issue=42')?.issue).toBe(42);
    expect(readEntryParams('?run=r&issue=0')?.issue).toBeUndefined();
    expect(readEntryParams('?run=r&issue=x')?.issue).toBeUndefined();
  });
});
