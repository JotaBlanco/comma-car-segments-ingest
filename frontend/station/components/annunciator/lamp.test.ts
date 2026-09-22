import { describe, expect, it } from 'vitest';
import { lampFor } from './lamp';

const PHASE = { '0': 'lamp-idle', '4': 'lamp-warn' };

describe('lampFor', () => {
  it('reads NO DATA and stays off on a null sample', () => {
    expect(lampFor(null, { '0': 'Stationary' }, 'PHASE', PHASE)).toEqual({
      label: 'NO DATA',
      cls: 'lamp readout lamp-off',
    });
  });
  it('uses the decoded text and the mapped class', () => {
    expect(lampFor(0, { '0': 'Stationary' }, 'PHASE', PHASE)).toEqual({
      label: 'Stationary',
      cls: 'lamp readout lamp-idle',
    });
    expect(lampFor(4, { '4': 'Degraded' }, 'PHASE', PHASE)).toEqual({
      label: 'Degraded',
      cls: 'lamp readout lamp-warn',
    });
  });
  it('stays neutral on a code with no decoded text', () => {
    expect(lampFor(2, { '0': 'Stationary' }, 'PHASE', PHASE)).toEqual({
      label: 'PHASE 2',
      cls: 'lamp readout lamp-idle',
    });
    expect(lampFor(1, undefined, 'FCS', {})).toEqual({
      label: 'FCS 1',
      cls: 'lamp readout lamp-idle',
    });
  });
  it('goes ok on any other decoded text', () => {
    expect(lampFor(1, { '1': 'Authorised for Full Flight' }, 'FCS', {})).toEqual({
      label: 'Authorised for Full Flight',
      cls: 'lamp readout lamp-ok',
    });
  });
  it('warns on a not-authorised state in either spelling', () => {
    expect(lampFor(2, { '2': 'Not Authorised' }, 'FCS', {}).cls).toBe('lamp readout lamp-warn');
    expect(lampFor(3, { '3': 'NOT AUTHORIZED for flight' }, 'FCS', {}).cls).toBe(
      'lamp readout lamp-warn',
    );
  });
  it('lets an explicit class override beat the text rules', () => {
    expect(lampFor(4, { '4': 'Not Authorised' }, 'PHASE', { '4': 'lamp-ok' }).cls).toBe(
      'lamp readout lamp-ok',
    );
  });
});
