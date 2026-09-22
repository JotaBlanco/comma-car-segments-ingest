const COMPACT_UTC = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})/;

/** `20260605T071847258Z` as `2026-06-05 07:18:47Z`; else as is. */
export function formatRecordingId(id: string): string {
  const m = COMPACT_UTC.exec(id);
  return m ? `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]}Z` : id;
}

/** `3725` as `1h 02m`, `125` as `2m 05s`: two units, the row is narrow. */
export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
}

/** The lake column a source level partitions by: `bus=INS1` -> `bus`. */
export function scopeKey(scope: string): string {
  const i = scope.indexOf('=');
  return i > 0 ? scope.slice(0, i) : 'source';
}

/** FTO scopes are FCCs; the bare number reads as nothing. */
export function scopeLabel(table: 'a429' | 'analog' | 'fto', scope: string): string {
  const value = scope.split('=')[1] ?? scope;
  return table === 'fto' ? `FCC ${value}` : value;
}
