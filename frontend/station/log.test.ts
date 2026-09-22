import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { log } from './log';

function stubStorage(entries: Record<string, string>) {
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => entries[k] ?? null,
  });
}

beforeEach(() => {
  vi.stubEnv('DEV', false);
  stubStorage({});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('log', () => {
  it('suppresses debug and info while the gate is off', () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    log.debug('api', 'quiet');
    log.info('api', 'quiet');
    expect(debug).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it('always emits warn and error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    log.warn('api', 'loud');
    log.error('api', 'louder');
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
  });

  it('emits debug when fts.debug is set', () => {
    stubStorage({ 'fts.debug': '1' });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    log.debug('boot', 'chatty');
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('emits debug in a dev build', () => {
    vi.stubEnv('DEV', true);
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    log.debug('boot', 'chatty');
    expect(debug).toHaveBeenCalledTimes(1);
  });

  it('prefixes the scope and a timestamp, and passes fields last', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.warn('api', 'request failed', { status: 502 });
    const [line, fields] = warn.mock.calls[0];
    expect(line).toMatch(/^\[fts:api] \d{4}-\d{2}-\d{2}T[\d:.]+Z request failed$/);
    expect(fields).toEqual({ status: 502 });
  });

  it('omits the fields argument when there are none', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    log.warn('api', 'bare');
    expect(warn.mock.calls[0]).toHaveLength(1);
  });

  it('treats storage that throws as gate off', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
    });
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    expect(() => log.debug('boot', 'quiet')).not.toThrow();
    expect(debug).not.toHaveBeenCalled();
  });
});
