import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const portal = vi.hoisted(() => ({
  embedded: true,
  sdkLoaded: true,
  /** ms after the SDK resolves at which the portal delivers a token; null = never. */
  tokenAfterMs: null as number | null,
  token: null as string | null,
  stored: null as string | null,
  listeners: new Set<(t: string | null) => void>(),
  portalListeners: new Set<(t: string) => void>(),
  /** ms after which a relaying parent answers; null = no relaying parent. */
  relayAfterMs: null as number | null,
}));

const chartReset = vi.hoisted(() => vi.fn());

vi.mock('../components/charts/colors', () => ({ resetChartTheme: chartReset }));

const eventsMock = vi.hoisted(() => ({
  opened: 0,
  onFrame: null as null | ((f: { event: string; data: string }) => void),
  onState: null as null | ((s: 'connected' | 'off') => void),
}));

vi.mock('../api/events', () => ({
  openEvents: (
    onFrame: (f: { event: string; data: string }) => void,
    onState: (s: 'connected' | 'off') => void,
  ) => {
    eventsMock.opened += 1;
    eventsMock.onFrame = onFrame;
    eventsMock.onState = onState;
    return { close: () => {} };
  },
}));

vi.mock('../api/token', () => ({
  getToken: () => portal.token,
  setToken: (t: string | null) => {
    portal.token = t;
    for (const l of portal.listeners) l(t);
  },
  onToken: (cb: (t: string | null) => void) => {
    portal.listeners.add(cb);
    return () => portal.listeners.delete(cb);
  },
  onPortalToken: (cb: (t: string) => void) => {
    portal.portalListeners.add(cb);
    return () => portal.portalListeners.delete(cb);
  },
  isEmbedded: () => portal.embedded,
  loadStoredPat: () => portal.stored,
  storePat: (t: string) => {
    portal.stored = t;
    portal.token = t;
    for (const l of portal.listeners) l(t);
  },
  clearStoredPat: () => {
    portal.stored = null;
  },
  initParentRelay: async () => {
    if (portal.relayAfterMs === null) return false;
    await new Promise((r) => setTimeout(r, portal.relayAfterMs ?? 0));
    portal.token = 'from-parent';
    for (const l of portal.listeners) l(portal.token);
    for (const l of portal.portalListeners) l(portal.token);
    return true;
  },
  initPluginSdk: async () => {
    if (portal.sdkLoaded && portal.tokenAfterMs !== null) {
      setTimeout(() => {
        portal.token = 'from-portal';
        for (const l of portal.listeners) l(portal.token);
        for (const l of portal.portalListeners) l(portal.token);
      }, portal.tokenAfterMs);
    }
    return portal.sdkLoaded;
  },
}));

function stubFetch() {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      paths.push(path);
      const body =
        path === '/api/fts/config'
          ? {
              tileUrl: 'https://tiles.test/{z}/{x}/{y}.png',
              authActive: true,
              flightStateHz: 10,
              agentId,
            }
          : { aircraft: [] };
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(''),
      });
    }),
  );
  return paths;
}

let authActive = true;
let agentId: string | null = null;

/** Config always succeeds; every other path answers with whatever status the test currently wants. */
function stubStatusFetch(status: () => number) {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      const ok = path === '/api/fts/config' || status() === 200;
      const body =
        path === '/api/fts/config'
          ? {
              tileUrl: 'https://tiles.test/{z}/{x}/{y}.png',
              authActive,
              flightStateHz: 10,
              agentId: null,
            }
          : { aircraft: [] };
      return Promise.resolve({
        ok,
        status: ok ? 200 : status(),
        json: () => Promise.resolve(body),
        text: () => Promise.resolve('token expired'),
      });
    }),
  );
}

function stubParamsFetch(ok: boolean, body: unknown) {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      paths.push(path);
      return Promise.resolve({
        ok,
        status: ok ? 200 : 500,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve('lake query failed'),
      });
    }),
  );
  return paths;
}

async function freshStore() {
  vi.resetModules();
  return (await import('./session')).useSession;
}

beforeEach(() => {
  vi.useFakeTimers();
  portal.embedded = true;
  portal.sdkLoaded = true;
  portal.tokenAfterMs = null;
  portal.relayAfterMs = null;
  portal.token = null;
  portal.stored = null;
  authActive = true;
  agentId = null;
  portal.listeners.clear();
  portal.portalListeners.clear();
  chartReset.mockClear();
  eventsMock.opened = 0;
  eventsMock.onFrame = null;
  eventsMock.onState = null;
  vi.stubGlobal('window', { location: { hash: '' } });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('selectRecording', () => {
  it('ignores a click on the recording that is already loaded', async () => {
    const paths: string[] = [];
    const flight = {
      t0_ms: 0,
      dt_ms: 100,
      n: 1,
      segments: [{ t0_ms: 0, t1_ms: 100, chunk_seq: 1 }],
      markers: [],
      cols: {},
      units: {},
      source: {},
      texts: {},
    };
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        paths.push(path);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(flight),
          text: () => Promise.resolve(''),
        });
      }),
    );
    vi.stubGlobal('history', { replaceState: () => {} });
    const useSession = await freshStore();

    await useSession.getState().selectRecording('sn003', 'r1');
    await useSession.getState().selectRecording('sn003', 'r1');

    expect(paths).toEqual(['/api/fts/flightstate/sn003/r1', '/api/fts/catalog/sn003/r1/snippets']);
    expect(useSession.getState().flight).toEqual(flight);
  });
});

describe('resetView', () => {
  it('clears the recording, picks and hash but keeps the catalog', async () => {
    const hashes: string[] = [];
    vi.stubGlobal('window', { location: { hash: '#/a=sn003&r=r1&s=a429:bus=INS1:lat' } });
    vi.stubGlobal('history', {
      replaceState: (_: unknown, __: string, h: string) => hashes.push(h),
    });
    const useSession = await freshStore();
    useSession.setState({
      catalog: { aircraft: [] },
      aircraft: 'sn003',
      recording: 'r1',
      flight: {} as never,
      picked: [{ key: 'a429:bus=INS1:lat', table: 'a429', scope: 'bus=INS1', signal: 'lat' }],
    });

    useSession.getState().resetView();

    const st = useSession.getState();
    expect(st.aircraft).toBeNull();
    expect(st.recording).toBeNull();
    expect(st.flight).toBeNull();
    expect(st.picked).toEqual([]);
    expect(st.catalog).toEqual({ aircraft: [] });
    expect(hashes.at(-1)).toBe('#/');
  });
});

describe('zoom view', () => {
  it('holds a drag range and drops it on reset', async () => {
    vi.stubGlobal('history', { replaceState: () => {} });
    const useSession = await freshStore();
    expect(useSession.getState().view).toBeNull();

    useSession.getState().setView({ t0_ms: 1000, t1_ms: 5000 });
    expect(useSession.getState().view).toEqual({ t0_ms: 1000, t1_ms: 5000 });

    useSession.getState().resetZoom();
    expect(useSession.getState().view).toBeNull();
  });

  it('is dropped when another recording is selected', async () => {
    const flight = {
      t0_ms: 0,
      dt_ms: 100,
      n: 1,
      segments: [{ t0_ms: 0, t1_ms: 100, chunk_seq: 1 }],
      markers: [],
      cols: {},
      units: {},
      source: {},
      texts: {},
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(flight),
          text: () => Promise.resolve(''),
        }),
      ),
    );
    vi.stubGlobal('history', { replaceState: () => {} });
    const useSession = await freshStore();
    useSession.getState().setView({ t0_ms: 1000, t1_ms: 5000 });

    await useSession.getState().selectRecording('sn003', 'r1');

    expect(useSession.getState().view).toBeNull();
  });
});

describe('toggleTree', () => {
  it('starts open and flips closed', async () => {
    const useSession = await freshStore();
    expect(useSession.getState().treeOpen).toBe(true);

    useSession.getState().toggleTree();

    expect(useSession.getState().treeOpen).toBe(false);
  });
});

describe('setTreeWidth', () => {
  it('clamps and stores the width', async () => {
    const useSession = await freshStore();
    expect(useSession.getState().treeWidth).toBe(300);

    useSession.getState().setTreeWidth(1000);

    expect(useSession.getState().treeWidth).toBe(480);
  });
});

describe('authResolved', () => {
  it('stays false while the token attempt is in flight and flips once it settles', async () => {
    stubFetch();
    const useSession = await freshStore();
    expect(useSession.getState().authResolved).toBe(false);

    const booted = useSession.getState().boot();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(useSession.getState().authResolved).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    await booted;

    expect(useSession.getState().authResolved).toBe(true);
    expect(useSession.getState().needsPat).toBe(true);
  });

  it('flips even when the config request fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('offline'))),
    );
    const useSession = await freshStore();

    await useSession.getState().boot();

    expect(useSession.getState().authResolved).toBe(true);
    expect(useSession.getState().error).toBe('offline');
  });
});

describe('boot in an embedded session', () => {
  it('takes the token a relaying parent answers when no plugin SDK arrives', async () => {
    portal.sdkLoaded = false;
    portal.relayAfterMs = 5;
    stubFetch();
    const useSession = await freshStore();

    const booted = useSession.getState().boot();
    await vi.advanceTimersByTimeAsync(5);
    await booted;

    const s = useSession.getState();
    expect(s.hasToken).toBe(true);
    expect(s.needsPat).toBe(false);
    expect(s.tokenSource).toBe('portal');
    expect(s.error).toBeNull();
  });

  it('asks for a PAT when the plugin SDK never arrives', async () => {
    portal.sdkLoaded = false;
    const paths = stubFetch();
    const useSession = await freshStore();

    await useSession.getState().boot();

    const s = useSession.getState();
    expect(s.needsPat).toBe(true);
    expect(s.hasToken).toBe(false);
    expect(s.error).toBe('Portal token unavailable — enter a PAT to continue');
    expect(paths).toEqual(['/api/fts/config']);
  });

  it('asks for a PAT when the portal delivers no token before the timeout', async () => {
    const paths = stubFetch();
    const useSession = await freshStore();

    const booted = useSession.getState().boot();
    await vi.advanceTimersByTimeAsync(10_000);
    await booted;

    const s = useSession.getState();
    expect(s.needsPat).toBe(true);
    expect(s.error).toBe('Portal token unavailable — enter a PAT to continue');
    expect(paths).toEqual(['/api/fts/config']);
  });

  it('loads the catalog once the portal delivers a token', async () => {
    portal.tokenAfterMs = 1000;
    const paths = stubFetch();
    const useSession = await freshStore();

    const booted = useSession.getState().boot();
    await vi.advanceTimersByTimeAsync(1000);
    await booted;

    const s = useSession.getState();
    expect(s.hasToken).toBe(true);
    expect(s.needsPat).toBe(false);
    expect(s.error).toBeNull();
    expect(paths).toEqual(['/api/fts/config', '/api/fts/catalog']);
  });

  it('suggests the Flight Test agent to the portal', async () => {
    portal.sdkLoaded = false;
    agentId = 'agent-123';
    const postMessage = vi.fn();
    stubFetch();
    vi.stubGlobal('window', { location: { hash: '' }, parent: { postMessage } });
    const useSession = await freshStore();

    await useSession.getState().initToken();

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage).toHaveBeenCalledWith(
      {
        type: 'quixai:suggestedAgent',
        suggestedAgentId: 'agent-123',
        source: 'FlightTestStation',
      },
      '*',
    );
  });

  it('clears the error and loads the catalog when a PAT is submitted', async () => {
    portal.sdkLoaded = false;
    const paths = stubFetch();
    const useSession = await freshStore();
    await useSession.getState().boot();

    await useSession.getState().submitPat('pat-123');

    const s = useSession.getState();
    expect(s.error).toBeNull();
    expect(s.needsPat).toBe(false);
    expect(s.hasToken).toBe(true);
    expect(paths).toEqual(['/api/fts/config', '/api/fts/catalog']);
  });
});

describe('tree levels', () => {
  const REC = { aircraft: 'sn003', recording: '20260605T071847258Z' };

  it('surfaces a failed scope lookup through the store error', async () => {
    const paths = stubParamsFetch(false, null);
    const useSession = await freshStore();
    useSession.setState(REC);

    await expect(useSession.getState().loadScopes('fto')).resolves.toBeUndefined();

    const s = useSession.getState();
    expect(s.scopesByNode).toEqual({});
    expect(s.error).toBe('lake query failed');
    expect(paths).toEqual(['/api/fts/catalog/sn003/20260605T071847258Z/scopes/fto']);
  });

  it('stores the scopes of a protocol and the signals of a scope, one call each', async () => {
    const paths = stubParamsFetch(true, {
      scopes: ['fcc=1', 'fcc=2'],
      signals: ['ail_1_ace_1_cmd'],
    });
    const useSession = await freshStore();
    useSession.setState({ ...REC, error: 'stale' });

    await useSession.getState().loadScopes('fto');
    await useSession.getState().loadSignals('fto', 'fcc=2');

    const s = useSession.getState();
    expect(s.scopesByNode['sn003/20260605T071847258Z/fto']).toEqual(['fcc=1', 'fcc=2']);
    expect(s.signalsByNode['sn003/20260605T071847258Z/fto/fcc=2']).toEqual(['ail_1_ace_1_cmd']);
    expect(s.error).toBeNull();
    expect(paths).toEqual([
      '/api/fts/catalog/sn003/20260605T071847258Z/scopes/fto',
      '/api/fts/catalog/sn003/20260605T071847258Z/signals/fto?scope=fcc%3D2',
    ]);
  });

  it('serves a level opened earlier in the session without another fetch', async () => {
    const paths = stubParamsFetch(true, { scopes: ['bus=INS1'], signals: ['pitch_angle'] });
    const useSession = await freshStore();
    useSession.setState(REC);
    await useSession.getState().loadScopes('a429');
    await useSession.getState().loadScopes('a429');
    useSession.setState({ aircraft: 'sn002', recording: 'other' });
    await useSession.getState().loadScopes('a429');
    useSession.setState(REC);
    await useSession.getState().loadScopes('a429');

    expect(paths).toEqual([
      '/api/fts/catalog/sn003/20260605T071847258Z/scopes/a429',
      '/api/fts/catalog/sn002/other/scopes/a429',
    ]);
  });
});

describe('submitPat when the catalog rejects the token', () => {
  function stubCatalog(status: number) {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        const ok = path === '/api/fts/config' || status === 200;
        const body =
          path === '/api/fts/config'
            ? {
                tileUrl: 'https://tiles.test/{z}/{x}/{y}.png',
                authActive: true,
                flightStateHz: 10,
                agentId: null,
              }
            : { aircraft: [] };
        return Promise.resolve({
          ok,
          status: ok ? 200 : status,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve('token rejected'),
        });
      }),
    );
  }

  it('reopens the prompt and drops the stored PAT when the catalog answers 401', async () => {
    portal.sdkLoaded = false;
    stubCatalog(401);
    const useSession = await freshStore();
    await useSession.getState().boot();

    await useSession.getState().submitPat('bad-pat');

    const s = useSession.getState();
    expect(s.needsPat).toBe(true);
    expect(s.hasToken).toBe(false);
    expect(portal.stored).toBeNull();
    expect(s.error).toBe('The Quix Portal refused that token. Check it and try again.');
  });

  it('keeps the modal up and surfaces the error on a non-401 failure', async () => {
    portal.sdkLoaded = false;
    stubCatalog(500);
    const useSession = await freshStore();
    await useSession.getState().boot();

    await useSession.getState().submitPat('good-pat');

    const s = useSession.getState();
    expect(s.needsPat).toBe(true);
    expect(s.authBusy).toBe(false);
    expect(portal.stored).toBe('good-pat');
    expect(s.error).toBe('token rejected');
    // storePat set the token, so hasToken is true even though the modal stays up.
    expect(s.hasToken).toBe(true);
  });

  it('keeps the app blocked while the catalog request is in flight', async () => {
    portal.sdkLoaded = false;
    let release: () => void = () => {};
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (path: string) => {
        if (path !== '/api/fts/config') await inFlight;
        const body =
          path === '/api/fts/config'
            ? {
                tileUrl: 'https://tiles.test/{z}/{x}/{y}.png',
                authActive: true,
                flightStateHz: 10,
                agentId: null,
              }
            : { aircraft: [] };
        return {
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(''),
        };
      }),
    );
    const useSession = await freshStore();
    await useSession.getState().boot();
    expect(useSession.getState().needsPat).toBe(true);

    const submitted = useSession.getState().submitPat('pat-123');
    await vi.advanceTimersByTimeAsync(0);

    expect(useSession.getState().needsPat).toBe(true);
    expect(useSession.getState().authBusy).toBe(true);

    release();
    await submitted;

    const s = useSession.getState();
    expect(s.needsPat).toBe(false);
    expect(s.hasToken).toBe(true);
    expect(s.authBusy).toBe(false);
  });
});

describe('a token the catalog refuses after boot', () => {
  it('reopens the modal and clears the stored PAT in a standalone session', async () => {
    portal.embedded = false;
    portal.stored = 'stale-pat';
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        const ok = path === '/api/fts/config';
        const body = ok
          ? {
              tileUrl: 'https://tiles.test/{z}/{x}/{y}.png',
              authActive: true,
              flightStateHz: 10,
              agentId: null,
            }
          : { aircraft: [] };
        return Promise.resolve({
          ok,
          status: ok ? 200 : 401,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve('token expired'),
        });
      }),
    );
    const useSession = await freshStore();

    await useSession.getState().boot();

    const s = useSession.getState();
    expect(s.needsPat).toBe(true);
    expect(s.hasToken).toBe(false);
    expect(portal.stored).toBeNull();
    expect(s.error).toBe('The Quix Portal refused that token. Check it and try again.');
  });

  it('leaves an embedded session on the plain error, since the portal token is not replaceable', async () => {
    portal.embedded = true;
    portal.tokenAfterMs = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        const ok = path === '/api/fts/config';
        const body = ok
          ? {
              tileUrl: 'https://tiles.test/{z}/{x}/{y}.png',
              authActive: true,
              flightStateHz: 10,
              agentId: null,
            }
          : { aircraft: [] };
        return Promise.resolve({
          ok,
          status: ok ? 200 : 401,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve('token expired'),
        });
      }),
    );
    const useSession = await freshStore();

    const booted = useSession.getState().boot();
    await vi.advanceTimersByTimeAsync(0);
    await booted;

    const s = useSession.getState();
    expect(s.needsPat).toBe(false);
    expect(s.hasToken).toBe(true);
    expect(s.tokenSource).toBe('portal');
    expect(s.error).toBe('token expired');
  });

  it('reopens the modal for a user PAT that an embedded session later has refused', async () => {
    portal.embedded = true;
    portal.sdkLoaded = false;
    let status = 200;
    stubStatusFetch(() => status);
    const useSession = await freshStore();
    await useSession.getState().boot();

    await useSession.getState().submitPat('user-pat');
    expect(useSession.getState().needsPat).toBe(false);
    expect(useSession.getState().tokenSource).toBe('pat');

    status = 401;
    await useSession.getState().loadCatalog();

    const s = useSession.getState();
    expect(s.needsPat).toBe(true);
    expect(s.hasToken).toBe(false);
    expect(s.tokenSource).toBeNull();
    expect(portal.stored).toBeNull();
    expect(s.error).toBe('The Quix Portal refused that token. Check it and try again.');
  });

  it('leaves a 401 alone when the deployment runs without auth', async () => {
    portal.embedded = false;
    authActive = false;
    stubStatusFetch(() => 401);
    const useSession = await freshStore();

    await useSession.getState().boot();

    const s = useSession.getState();
    expect(s.needsPat).toBe(false);
    expect(s.tokenSource).toBeNull();
    expect(s.error).toBe('token expired');
  });

  it('keeps the modal up when a second PAT is refused after a catalog has already loaded', async () => {
    portal.embedded = false;
    portal.stored = 'stale-pat';
    let status = 200;
    stubStatusFetch(() => status);
    const useSession = await freshStore();
    await useSession.getState().boot();
    expect(useSession.getState().catalog).not.toBeNull();

    // The token expires mid-session: Retry 401s, then the replacement PAT is refused too.
    status = 401;
    await useSession.getState().loadCatalog();
    await useSession.getState().submitPat('another-bad-pat');

    const s = useSession.getState();
    expect(s.needsPat).toBe(true);
    expect(s.hasToken).toBe(false);
    expect(s.authBusy).toBe(false);
    expect(s.tokenSource).toBeNull();
    expect(portal.stored).toBeNull();
    expect(portal.token).toBeNull();
    expect(s.error).toBe('The Quix Portal refused that token. Check it and try again.');
  });
});

describe('submitPat when the catalog loads but the recording does not', () => {
  it('accepts the token and leaves the flight state error on the banner', async () => {
    portal.sdkLoaded = false;
    vi.stubGlobal('window', { location: { hash: '#/a=sn003&r=rec1' } });
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        const ok = path !== '/api/fts/flightstate/sn003/rec1';
        const body =
          path === '/api/fts/config'
            ? {
                tileUrl: 'https://tiles.test/{z}/{x}/{y}.png',
                authActive: true,
                flightStateHz: 10,
                agentId: null,
              }
            : { aircraft: [] };
        return Promise.resolve({
          ok,
          status: ok ? 200 : 500,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve('flight state failed'),
        });
      }),
    );
    const useSession = await freshStore();
    await useSession.getState().boot();

    await useSession.getState().submitPat('good-pat');

    const s = useSession.getState();
    expect(s.needsPat).toBe(false);
    expect(s.authBusy).toBe(false);
    expect(s.catalog).toEqual({ aircraft: [] });
    expect(s.error).toBe('flight state failed');
  });
});

describe('theme toggle', () => {
  it('drops the cached chart palette so the next chart reads the new theme', async () => {
    // Inside the Test Manager the theme sits on the station's root, and starts light.
    vi.stubGlobal('document', { documentElement: { dataset: {} }, querySelectorAll: () => [] });
    const useSession = await freshStore();

    useSession.getState().toggleTheme();

    expect(useSession.getState().theme).toBe('dark');
    expect(chartReset).toHaveBeenCalledTimes(1);
  });
});

describe('togglePanel', () => {
  it('starts expanded, flips one panel and writes it to the hash', async () => {
    const hashes: string[] = [];
    vi.stubGlobal('history', {
      replaceState: (_: unknown, __: string, h: string) => hashes.push(h),
    });
    const useSession = await freshStore();
    expect(useSession.getState().collapsed).toEqual({
      map: false,
      altitude: false,
      instruments: false,
      annunciator: false,
      strips: false,
    });

    useSession.getState().togglePanel('map');

    expect(useSession.getState().collapsed.map).toBe(true);
    expect(hashes.at(-1)).toBe('#/c=map');

    useSession.getState().togglePanel('map');

    expect(useSession.getState().collapsed.map).toBe(false);
    expect(hashes.at(-1)).toBe('#/');
  });

  it('restores the collapsed panels from the hash on boot', async () => {
    stubFetch();
    vi.stubGlobal('window', { location: { hash: '#/c=altitude,annunciator' } });
    vi.stubGlobal('history', { replaceState: () => {} });
    const useSession = await freshStore();

    await useSession.getState().loadCatalog();

    expect(useSession.getState().collapsed).toEqual({
      map: false,
      altitude: true,
      instruments: false,
      annunciator: true,
      strips: false,
    });
  });
});

describe('zoom in the hash', () => {
  it('writes v on setView and clears it on resetZoom', async () => {
    const hashes: string[] = [];
    vi.stubGlobal('history', {
      replaceState: (_: unknown, __: string, h: string) => hashes.push(h),
    });
    const useSession = await freshStore();
    useSession.setState({ aircraft: 'sn003', recording: 'r1' });

    useSession.getState().setView({ t0_ms: 1000, t1_ms: 5000 });
    expect(hashes.at(-1)).toContain('v=1000%2C5000');

    useSession.getState().resetZoom();
    expect(hashes.at(-1)).not.toContain('v=');
  });

  it('applies v from the hash after the recording loads', async () => {
    const flight = {
      t0_ms: 0,
      dt_ms: 100,
      n: 1,
      segments: [{ t0_ms: 0, t1_ms: 100, chunk_seq: 1 }],
      markers: [],
      cols: {},
      units: {},
      source: {},
      texts: {},
    };
    vi.stubGlobal('window', { location: { hash: '#/a=sn003&r=r1&v=10%2C50' } });
    vi.stubGlobal('history', { replaceState: () => {} });
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(path === '/api/fts/catalog' ? { aircraft: [] } : flight),
          text: () => Promise.resolve(''),
        }),
      ),
    );
    const useSession = await freshStore();

    await useSession.getState().loadCatalog();

    expect(useSession.getState().view).toEqual({ t0_ms: 10, t1_ms: 50 });
  });
});

const FLIGHT = {
  t0_ms: 0,
  dt_ms: 100,
  n: 1,
  segments: [{ t0_ms: 0, t1_ms: 100, chunk_seq: 1 }],
  markers: [],
  cols: {},
  units: {},
  source: {},
  texts: {},
};
const CATALOG = {
  aircraft: [
    {
      id: 'sn003',
      recordings: [
        { id: 'r1', run_id: 'sn003_r1', tables: ['a429', 'analog'], t0_ms: 0, t1_ms: 100 },
      ],
    },
  ],
};
const PLAN = {
  run_id: 'sn003_r1',
  traces: [
    { protocol: 'a429', scope: 'bus=INS1', signal: 'pitch_angle' },
    { protocol: 'analog', scope: 'stream=tail_accel', signal: 'T001_A_LH_FWD_UPP_Y' },
  ],
  t0_ms: 10,
  t1_ms: 50,
  t_ms: 20,
} as const;

function stubCatalogAndFlight() {
  const paths: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      paths.push(path);
      const body = path === '/api/fts/catalog' ? CATALOG : FLIGHT;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
        text: () => Promise.resolve(''),
      });
    }),
  );
  return paths;
}

const TWO_RUNS = {
  aircraft: [
    {
      id: 'sn003',
      recordings: [
        { id: 'r1', run_id: 'sn003_r1', tables: ['a429', 'analog'], t0_ms: 0, t1_ms: 100 },
        { id: 'r2', run_id: 'sn003_r2', tables: ['a429'], t0_ms: 0, t1_ms: 100 },
      ],
    },
  ],
};
const PLAN_2 = {
  run_id: 'sn003_r2',
  traces: [{ protocol: 'a429', scope: 'bus=INS2', signal: 'roll_angle' }],
  t0_ms: 60,
  t1_ms: 90,
  t_ms: 70,
} as const;

/** Settles after n microtask ticks, so a load can be outrun. */
function after<T>(value: T, ticks: number): Promise<T> {
  let p = Promise.resolve(value);
  for (let i = 0; i < ticks; i += 1) p = p.then((v) => v);
  return p;
}

function flush(ticks: number): Promise<unknown> {
  return after(null, ticks);
}

/** r1's flight state lands long after r2's, exposing order. */
function stubTwoRunsSlowFirst() {
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      const res = {
        ok: true,
        status: 200,
        json: () => Promise.resolve(path === '/api/fts/catalog' ? TWO_RUNS : FLIGHT),
        text: () => Promise.resolve(''),
      };
      return path === '/api/fts/flightstate/sn003/r1' ? after(res, 200) : Promise.resolve(res);
    }),
  );
}

describe('applyPlan', () => {
  it('selects the run, replaces the picks, zooms and writes the hash', async () => {
    const hashes: string[] = [];
    stubCatalogAndFlight();
    vi.stubGlobal('history', {
      replaceState: (_: unknown, __: string, h: string) => hashes.push(h),
    });
    const useSession = await freshStore();
    useSession.setState({
      catalog: CATALOG as never,
      picked: [{ key: 'fto:fcc=1:x', table: 'fto', scope: 'fcc=1', signal: 'x' }],
    });

    await useSession.getState().applyPlan(PLAN as never);

    const st = useSession.getState();
    expect(st.aircraft).toBe('sn003');
    expect(st.recording).toBe('r1');
    expect(st.picked.map((p) => p.key)).toEqual([
      'a429:bus=INS1:pitch_angle',
      'analog:stream=tail_accel:T001_A_LH_FWD_UPP_Y',
    ]);
    expect(st.view).toEqual({ t0_ms: 10, t1_ms: 50 });
    expect(hashes.at(-1)).toContain('v=10%2C50');
    expect(hashes.at(-1)).toContain('a=sn003');
  });

  it('seeks instead of reloading when the run is already on screen', async () => {
    const paths = stubCatalogAndFlight();
    vi.stubGlobal('history', { replaceState: () => {} });
    const useSession = await freshStore();
    useSession.setState({ catalog: CATALOG as never });
    await useSession.getState().selectRecording('sn003', 'r1');
    paths.length = 0;

    await useSession.getState().applyPlan({ ...PLAN, t0_ms: null, t1_ms: null, t_ms: 60 } as never);

    expect(paths).toEqual([]);
    expect(useSession.getState().view).toBeNull();
    const { clock } = await import('../playback/clock');
    expect(clock.t).toBe(60);
  });

  it('ignores a plan for a run the catalog does not know', async () => {
    const paths = stubCatalogAndFlight();
    const useSession = await freshStore();
    useSession.setState({ catalog: CATALOG as never });

    await useSession.getState().applyPlan({ ...PLAN, run_id: 'nope' } as never);

    expect(paths).toEqual([]);
    expect(useSession.getState().recording).toBeNull();
  });
});

describe('agent link', () => {
  it('opens the event stream once after the catalog loads and tracks its state', async () => {
    stubCatalogAndFlight();
    vi.stubGlobal('history', { replaceState: () => {} });
    const useSession = await freshStore();

    await useSession.getState().loadCatalog();
    await useSession.getState().loadCatalog();

    expect(eventsMock.opened).toBe(1);
    expect(useSession.getState().aiLink).toBe('off');
    eventsMock.onState?.('connected');
    expect(useSession.getState().aiLink).toBe('connected');
  });

  it('applies a show_traces frame and ignores malformed data', async () => {
    stubCatalogAndFlight();
    vi.stubGlobal('history', { replaceState: () => {} });
    const useSession = await freshStore();
    await useSession.getState().loadCatalog();

    eventsMock.onFrame?.({ event: 'show_traces', data: 'not json' });
    expect(useSession.getState().recording).toBeNull();

    eventsMock.onFrame?.({ event: 'show_traces', data: JSON.stringify(PLAN) });
    await vi.waitFor(() => expect(useSession.getState().recording).toBe('r1'));
  });

  it('applies back-to-back plans in arrival order', async () => {
    stubTwoRunsSlowFirst();
    vi.stubGlobal('history', { replaceState: () => {} });
    const useSession = await freshStore();
    useSession.setState({ catalog: TWO_RUNS as never });
    useSession.getState().startEvents();

    eventsMock.onFrame?.({ event: 'show_traces', data: JSON.stringify(PLAN) });
    eventsMock.onFrame?.({ event: 'show_traces', data: JSON.stringify(PLAN_2) });
    await flush(600);

    const st = useSession.getState();
    expect(st.recording).toBe('r2');
    expect(st.picked.map((p) => p.key)).toEqual(['a429:bus=INS2:roll_angle']);
    expect(st.view).toEqual({ t0_ms: 60, t1_ms: 90 });
  });
});

describe('selected period', () => {
  it('holds a marked range, clears it, and remembers the drag mode', async () => {
    const stored: Record<string, string> = {};
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => stored[k] ?? null,
      setItem: (k: string, v: string) => {
        stored[k] = v;
      },
    });
    vi.stubGlobal('history', { replaceState: () => {} });
    const useSession = await freshStore();
    expect(useSession.getState().selection).toBeNull();
    expect(useSession.getState().dragMode).toBe('zoom');

    useSession.getState().setSelection({ t0_ms: 1000, t1_ms: 5000 });
    expect(useSession.getState().selection).toEqual({ t0_ms: 1000, t1_ms: 5000 });
    useSession.getState().clearSelection();
    expect(useSession.getState().selection).toBeNull();

    useSession.getState().setDragMode('select');
    expect(useSession.getState().dragMode).toBe('select');
    expect(stored['fts.drag']).toBe('select');
  });

  it('writes sel to the hash and drops it with the recording', async () => {
    const hashes: string[] = [];
    vi.stubGlobal('history', {
      replaceState: (_: unknown, __: string, h: string) => hashes.push(h),
    });
    const useSession = await freshStore();
    useSession.setState({ aircraft: 'sn003', recording: 'r1' });
    useSession.getState().setSelection({ t0_ms: 2000, t1_ms: 3000 });
    expect(hashes.at(-1)).toContain('sel=2000%2C3000');
    useSession.getState().clearSelection();
    expect(hashes.at(-1)).not.toContain('sel=');

    useSession.getState().setSelection({ t0_ms: 2000, t1_ms: 3000 });
    useSession.getState().resetView();
    expect(useSession.getState().selection).toBeNull();
  });
});

describe('openEntry', () => {
  const RUN = 'sn003_20260605T071847258Z';
  const catalog = {
    aircraft: [{ id: 'sn003', recordings: [{ id: 'r1', run_id: RUN, tables: ['a429'] }] }],
  };
  const flight = {
    t0_ms: 0,
    dt_ms: 1,
    n: 1,
    segments: [],
    markers: [],
    cols: {},
    units: {},
    source: {},
    texts: {},
  };

  function stubApi(hashes: string[], resolve: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn((path: string) => {
        const body = path.includes('/resolve')
          ? resolve
          : path.includes('/flightstate')
            ? flight
            : catalog;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(body),
          text: () => Promise.resolve(''),
        });
      }),
    );
    vi.stubGlobal('history', {
      replaceState: (_: unknown, __: string, h: string) => hashes.push(h),
    });
  }

  it('picks the signals the link names and writes them to the hash', async () => {
    const hashes: string[] = [];
    vi.stubGlobal('window', { location: { hash: '', search: `?run=${RUN}&signal=pitch` } });
    stubApi(hashes, { picks: [{ name: 'pitch', table: 'a429', scope: 'bus=INS1' }] });
    const useSession = await freshStore();

    await useSession.getState().loadCatalog();

    const st = useSession.getState();
    expect(st.recording).toBe('r1');
    expect(st.picked).toEqual([
      { key: 'a429:bus=INS1:pitch', table: 'a429', scope: 'bus=INS1', signal: 'pitch' },
    ]);
    expect(hashes.at(-1)).toContain('s=a429%3Abus%3DINS1%3Apitch');
  });

  it('drops a pick the old hash held when the link names no signal', async () => {
    const hashes: string[] = [];
    vi.stubGlobal('window', {
      location: { hash: '#/a=sn003&r=other&s=a429:bus=INS9:stale', search: `?run=${RUN}` },
    });
    stubApi(hashes, { picks: [] });
    const useSession = await freshStore();

    await useSession.getState().loadCatalog();

    expect(useSession.getState().picked).toEqual([]);
  });
});

describe('picked snippets', () => {
  it('toggles one, picks all, derives the events, and writes the ids to the hash', async () => {
    const hashes: string[] = [];
    vi.stubGlobal('history', {
      replaceState: (_: unknown, __: string, h: string) => hashes.push(h),
    });
    const useSession = await freshStore();
    const snippet = (id: number, t0: number | null, t1: number | null) => ({
      id,
      name: `s${id}`,
      note: '',
      t0_ms: t0,
      t1_ms: t1,
      scope: 'bus=INS1',
      signal: 'alt',
      found_by: null,
      tags: [],
      sql: '',
      markdown: '',
      partitions: [],
      created_at: null,
    });
    useSession.setState({
      aircraft: 'sn003',
      recording: 'r1',
      snippets: [snippet(1, 1000, 2000), snippet(2, 3000, 3000), snippet(3, null, null)],
    });
    useSession.getState().toggleSnippet(2);
    expect(useSession.getState().pickedSnippets).toEqual([2]);
    expect(useSession.getState().events.map((e) => e.id)).toEqual([2]);
    expect(hashes.at(-1)).toContain('an=2');

    useSession.getState().pickAllSnippets(true);
    expect(useSession.getState().pickedSnippets).toEqual([1, 2]);
    expect(useSession.getState().events.map((e) => e.id)).toEqual([1, 2]);
    useSession.getState().pickAllSnippets(false);
    expect(useSession.getState().events).toEqual([]);
    expect(hashes.at(-1)).not.toContain('an=');
  });
});
