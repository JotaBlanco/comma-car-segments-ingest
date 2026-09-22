import { describe, expect, it } from 'vitest';
import type { SnippetDto } from '../api/types';
import { eventLabel, fmtEventSpan, pickedEvents, scopeValue } from './events';

function snip(over: Partial<SnippetDto>): SnippetDto {
  return {
    id: 1,
    name: 'INS1 · inertial_altitude · 1000 - 2000',
    note: '',
    t0_ms: 1000,
    t1_ms: 2000,
    scope: 'bus=INS1',
    signal: 'inertial_altitude',
    found_by: null,
    tags: [],
    sql: '',
    markdown: '',
    partitions: [],
    created_at: null,
    ...over,
  };
}

describe('pickedEvents', () => {
  it('keeps the picked, dated snippets in time order and marks instants', () => {
    const list = [
      snip({ id: 1, t0_ms: 5000, t1_ms: 5000 }),
      snip({ id: 2, t0_ms: 1000, t1_ms: 3000 }),
      snip({ id: 3, t0_ms: null, t1_ms: null }),
      snip({ id: 4 }),
    ];
    const out = pickedEvents(list, [1, 2, 3]);
    expect(out.map((e) => [e.id, e.instant])).toEqual([
      [2, false],
      [1, true],
    ]);
    expect(out[0].label).toBe('inertial_altitude · INS1');
  });
});

describe('labels and spans', () => {
  it('names the signal and source, else the snippet', () => {
    expect(eventLabel(snip({ scope: null }))).toBe('inertial_altitude');
    expect(eventLabel(snip({ signal: null, scope: null }))).toBe(
      'INS1 · inertial_altitude · 1000 - 2000',
    );
    expect(scopeValue('fcc=2')).toBe('2');
    expect(scopeValue(null)).toBeNull();
  });
  it('formats a span at a readable precision', () => {
    const at = (t0: number, t1: number) => pickedEvents([snip({ t0_ms: t0, t1_ms: t1 })], [1])[0];
    expect(fmtEventSpan(at(0, 0))).toBe('instant');
    expect(fmtEventSpan(at(0, 450))).toBe('450 ms');
    expect(fmtEventSpan(at(0, 12_300))).toBe('12.3 s');
    expect(fmtEventSpan(at(0, 125_000))).toBe('2m 05s');
  });
});
