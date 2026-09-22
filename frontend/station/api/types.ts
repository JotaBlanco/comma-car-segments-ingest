export type TableKind = 'a429' | 'analog' | 'fto';

export interface Recording {
  id: string;
  /** The lake folder: pcap-import's `<aircraft>_<recording>`, or a declared run id. */
  run_id: string;
  tables: TableKind[];
}
export interface Aircraft {
  id: string;
  recordings: Recording[];
}
export interface Catalog {
  aircraft: Aircraft[];
}
/** Sources under one protocol of a recording: `bus=INS1`, `stream=...`, `fcc=1`. */
export interface ScopesDto {
  scopes: string[];
}
/** Signals under one source. */
export interface SignalsDto {
  signals: string[];
}
/** One of the lake's data snippets that belongs to the recording: a saved selection
 *  (QuixLab's anomalies, an engineer's bookmark) and the period it marks. */
export interface SnippetDto {
  id: number;
  name: string;
  note: string;
  t0_ms: number | null;
  t1_ms: number | null;
  scope: string | null;
  signal: string | null;
  found_by: string | null;
  tags: string[];
  sql: string;
  markdown: string;
  partitions: string[];
  created_at: string | null;
}
export interface SnippetsDto {
  table: string;
  snippets: SnippetDto[];
}

export interface SegmentDto {
  t0_ms: number;
  t1_ms: number;
  chunk_seq: number;
}
export interface MarkerDto {
  t_ms: number;
  kind: string;
  from: number;
  to: number;
  text: string;
}
// Mirrors the replay keys in fts/params.py; change together.
export type ColName =
  'lat' | 'lon' | 'alt' | 'pitch' | 'roll' | 'hdg' | 'gs' | 'cas' | 'tas' | 'vs' | 'phase' | 'fcs';
export interface FlightStateDto {
  t0_ms: number;
  dt_ms: number;
  n: number;
  segments: SegmentDto[];
  markers: MarkerDto[];
  cols: Record<ColName, (number | null)[]>;
  units: Record<ColName, string>;
  source: Record<ColName, string>;
  texts: Partial<Record<ColName, Record<string, string>>>;
}
export interface SeriesDto {
  table: TableKind;
  scope: string;
  signal: string;
  unit: string;
  /** Rows the window holds, before the M4 reduction. */
  count: number;
  t_ms: number[];
  v: (number | null)[];
}
export interface AppConfig {
  tileUrl: string;
  authActive: boolean;
  flightStateHz: number;
  agentId: string | null;
}

export interface TraceRef {
  protocol: TableKind;
  scope: string;
  signal: string;
}
/** Mirrors fts/plans.py ShowTracesPlan; change together. */
export interface ShowTracesPlan {
  run_id: string;
  traces: TraceRef[];
  t0_ms: number | null;
  t1_ms: number | null;
  t_ms: number | null;
}

/** One signal placed in the scope of a run that carries it. */
export interface PickDto {
  name: string;
  table: TableKind;
  scope: string;
}

export interface ResolveDto {
  picks: PickDto[];
}
