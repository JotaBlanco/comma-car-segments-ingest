import { apiGet } from './client';
import type {
  AppConfig,
  Catalog,
  FlightStateDto,
  ScopesDto,
  SeriesDto,
  ResolveDto,
  SignalsDto,
  SnippetsDto,
  TableKind,
} from './types';

const enc = encodeURIComponent;

export const fetchConfig = () => apiGet<AppConfig>('/api/config');
export const fetchCatalog = () => apiGet<Catalog>('/api/catalog');
/** The tree opens one level per call, each a lake catalog lookup: no query ever runs for it. */
export const fetchScopes = (a: string, r: string, kind: TableKind) =>
  apiGet<ScopesDto>(`/api/catalog/${enc(a)}/${enc(r)}/scopes/${kind}`);
export const fetchSignals = (a: string, r: string, kind: TableKind, scope: string) =>
  apiGet<SignalsDto>(`/api/catalog/${enc(a)}/${enc(r)}/signals/${kind}?scope=${enc(scope)}`);
/** Place signals a caller named by name alone; the station picks the scope carrying each. */
export const fetchResolve = (a: string, r: string, names: string[]) =>
  apiGet<ResolveDto>(
    `/api/catalog/${enc(a)}/${enc(r)}/resolve?${names.map((n) => `signal=${enc(n)}`).join('&')}`,
  );
/** The lake's data snippets that belong to the recording, each with the period it marks. */
export const fetchSnippets = (a: string, r: string) =>
  apiGet<SnippetsDto>(`/api/catalog/${enc(a)}/${enc(r)}/snippets`);
export const fetchFlightState = (a: string, r: string) =>
  apiGet<FlightStateDto>(`/api/flightstate/${enc(a)}/${enc(r)}`);

export interface SeriesQuery {
  table: TableKind;
  scope: string;
  signal: string;
  t0: number;
  t1: number;
  /** M4 bucket count: the strip's plot width in pixels. */
  buckets?: number;
}

export function fetchSeries(a: string, r: string, q: SeriesQuery): Promise<SeriesDto> {
  const p = new URLSearchParams({
    table: q.table,
    scope: q.scope,
    signal: q.signal,
    t0: String(q.t0),
    t1: String(q.t1),
    buckets: String(q.buckets ?? 2000),
  });
  return apiGet<SeriesDto>(`/api/series/${enc(a)}/${enc(r)}?${p}`);
}
