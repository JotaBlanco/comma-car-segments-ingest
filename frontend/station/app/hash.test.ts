import { describe, expect, it } from 'vitest';
import { parseHash, serializeHash } from './hash';

describe('hash', () => {
  it('round-trips aircraft, recording, time and picks', () => {
    const s = {
      a: 'sn003',
      r: '20260605T071847258Z',
      t: 1780645772980,
      s: ['fto:fcc=2:fcc_2_pitch_cmd'],
      c: [],
    };
    expect(parseHash(serializeHash(s))).toEqual(s);
  });
  it('tolerates an empty hash', () => {
    expect(parseHash('')).toEqual({ s: [], c: [] });
  });
  it('round-trips the collapsed panel list', () => {
    const s = { s: [], c: ['map' as const, 'annunciator' as const] };
    expect(serializeHash(s)).toBe('#/c=map%2Cannunciator');
    expect(parseHash(serializeHash(s))).toEqual(s);
  });
  it('omits c when no panel is collapsed', () => {
    expect(serializeHash({ s: [], c: [] })).toBe('#/');
  });
  it('drops unknown collapsed ids', () => {
    expect(parseHash('#/c=map,nope,altitude')).toEqual({ s: [], c: ['map', 'altitude'] });
  });
  it('round-trips the zoom window as v=t0,t1', () => {
    const s = { s: [], c: [], v: [1000, 5000] as [number, number] };
    expect(serializeHash(s)).toBe('#/v=1000%2C5000');
    expect(parseHash(serializeHash(s))).toEqual(s);
  });
  it('drops a malformed or inverted v', () => {
    expect(parseHash('#/v=abc')).toEqual({ s: [], c: [] });
    expect(parseHash('#/v=5000,1000')).toEqual({ s: [], c: [] });
    expect(parseHash('#/v=1000')).toEqual({ s: [], c: [] });
  });
});

describe('selection', () => {
  it('round-trips the selected period next to the zoom window', () => {
    const s = {
      s: [],
      c: [],
      v: [1000, 5000] as [number, number],
      sel: [2000, 3000] as [number, number],
    };
    expect(parseHash(serializeHash(s))).toEqual(s);
  });
  it('drops a malformed or inverted selection and keeps the rest', () => {
    expect(parseHash('#/sel=3000,2000&v=1,2').sel).toBeUndefined();
    expect(parseHash('#/sel=abc').v).toBeUndefined();
    expect(parseHash('#/sel=3000,2000&v=1,2').v).toEqual([1, 2]);
  });
});

describe('picked snippets', () => {
  it('round-trips the ids and drops junk', () => {
    expect(parseHash(serializeHash({ s: [], c: [], an: [7, 12] })).an).toEqual([7, 12]);
    expect(parseHash('#/an=7,x,-1,12').an).toEqual([7, 12]);
    expect(parseHash('#/').an).toBeUndefined();
    expect(parseHash('#/an=x').an).toBeUndefined();
    expect(serializeHash({ s: [], c: [], an: [] })).not.toContain('an=');
  });
});
