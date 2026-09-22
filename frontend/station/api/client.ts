import { PORTAL_TOKEN_HEADER } from '@/lib/portal/token-store';
import { log } from '../log';
import { getToken } from './token';

/* The station's `/api/...` paths, served by the Test Manager's own route
   handler, which forwards them to the station's backend with the viewer's
   token (`app/api/fts/[...path]/route.ts`). The browser never leaves this
   origin. */
const PROXY = '/api/fts';

export function proxied(path: string): string {
  return path.startsWith('/api/') ? `${PROXY}${path.slice('/api'.length)}` : path;
}

/** The headers the proxy reads the viewer by. */
export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}`, [PORTAL_TOKEN_HEADER]: t } : {};
}

export class ApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export async function apiGet<T>(path: string): Promise<T> {
  const headers = authHeaders();
  const started = performance.now();
  const r = await send(path, headers, started);
  const ms = Math.round(performance.now() - started);
  if (!r.ok) {
    const body = (await r.text()) || r.statusText;
    log.warn('api', 'request rejected', { method: 'GET', path, status: r.status, ms });
    throw new ApiError(r.status, body);
  }
  log.debug('api', 'request ok', { method: 'GET', path, status: r.status, ms });
  return (await r.json()) as T;
}

async function send(path: string, headers: Record<string, string>, started: number) {
  try {
    return await fetch(proxied(path), { headers });
  } catch (e) {
    const ms = Math.round(performance.now() - started);
    log.error('api', 'request failed', { method: 'GET', path, ms, error: String(e) });
    throw e;
  }
}
