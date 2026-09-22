type Fields = Record<string, unknown>;
type Level = 'debug' | 'info' | 'warn' | 'error';

const RANK: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const DEBUG_KEY = 'fts.debug';

function devBuild(): boolean {
  try {
    return import.meta.env.DEV === true;
  } catch {
    return false;
  }
}

function debugParam(): boolean {
  try {
    return new URLSearchParams(location.search).get('debug') === '1';
  } catch {
    return false;
  }
}

function debugStored(): boolean {
  try {
    return localStorage.getItem(DEBUG_KEY) === '1';
  } catch {
    return false;
  }
}

// Read per call so fts.debug takes effect without a reload.
function threshold(): number {
  return devBuild() || debugParam() || debugStored() ? RANK.debug : RANK.warn;
}

function emit(level: Level, scope: string, msg: string, fields?: Fields): void {
  if (RANK[level] < threshold()) return;
  const line = `[fts:${scope}] ${new Date().toISOString()} ${msg}`;
  if (fields === undefined) console[level](line);
  else console[level](line, fields);
}

/** App-wide logger. Never log a token or PAT in `fields`. */
export const log = {
  debug: (scope: string, msg: string, fields?: Fields) => emit('debug', scope, msg, fields),
  info: (scope: string, msg: string, fields?: Fields) => emit('info', scope, msg, fields),
  warn: (scope: string, msg: string, fields?: Fields) => emit('warn', scope, msg, fields),
  error: (scope: string, msg: string, fields?: Fields) => emit('error', scope, msg, fields),
};
