import { describe, expect, it } from 'vitest';
import { formatDuration, formatRecordingId, scopeKey, scopeLabel } from './format';

describe('formatRecordingId', () => {
  it('renders a compact UTC recording id as a readable timestamp', () => {
    expect(formatRecordingId('20260605T071847258Z')).toBe('2026-06-05 07:18:47Z');
  });
  it('returns a non-matching id unchanged', () => {
    expect(formatRecordingId('rec-001')).toBe('rec-001');
  });
});

describe('formatDuration', () => {
  it('keeps two units so the row stays narrow', () => {
    expect(formatDuration(45)).toBe('45s');
    expect(formatDuration(125)).toBe('2m 05s');
    expect(formatDuration(3725)).toBe('1h 02m');
  });
});

describe('scope rows', () => {
  it('names the partition column behind a scope', () => {
    expect(scopeKey('bus=INS1')).toBe('bus');
    expect(scopeKey('fcc=1')).toBe('fcc');
    expect(scopeKey('INS1')).toBe('source');
  });
  it('reads an FCC number as an FCC and everything else as its value', () => {
    expect(scopeLabel('fto', 'fcc=2')).toBe('FCC 2');
    expect(scopeLabel('a429', 'bus=INS1')).toBe('INS1');
  });
});
