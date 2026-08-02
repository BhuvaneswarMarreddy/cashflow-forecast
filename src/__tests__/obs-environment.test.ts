/**
 * @jest-environment node
 *
 * Environment protection: the diagnostics surface must not exist in production.
 * Runs in the node environment because `next/server` needs the real web Request.
 *
 * Each case re-imports the modules under a forced NEXT_PUBLIC_OBS_ENV so the
 * production branch is exercised for real rather than asserted about.
 */

const withEnv = async <T>(env: string, fn: (mods: {
  route: typeof import('@/app/api/diagnostics/trace/route');
  events: typeof import('@/lib/obs/events');
}) => Promise<T> | T): Promise<T> => {
  const previous = process.env.NEXT_PUBLIC_OBS_ENV;
  process.env.NEXT_PUBLIC_OBS_ENV = env;
  try {
    let result!: T;
    await jest.isolateModulesAsync(async () => {
      const route = await import('@/app/api/diagnostics/trace/route');
      const events = await import('@/lib/obs/events');
      result = await fn({ route, events });
    });
    return result;
  } finally {
    if (previous === undefined) delete process.env.NEXT_PUBLIC_OBS_ENV;
    else process.env.NEXT_PUBLIC_OBS_ENV = previous;
  }
};

const req = (url = 'http://localhost/api/diagnostics/trace', init?: RequestInit) =>
  new Request(url, init) as unknown as import('next/server').NextRequest;

// NextRequest exposes nextUrl; the plain Request used above does not, so give it one.
const nextReq = (url = 'http://localhost/api/diagnostics/trace', init?: RequestInit) => {
  const r = req(url, init) as any;
  r.nextUrl = new URL(url);
  return r as import('next/server').NextRequest;
};

describe('production lockout', () => {
  it('GET does not exist in production', async () => {
    const status = await withEnv('production', async ({ route }) => (await route.GET(nextReq())).status);
    expect(status).toBe(404);
  });

  it('GET by trace id does not exist in production', async () => {
    const status = await withEnv('production', async ({ route }) =>
      (await route.GET(nextReq('http://localhost/api/diagnostics/trace?traceId=' + 'a'.repeat(32)))).status
    );
    expect(status).toBe(404);
  });

  it('POST ingestion does not exist in production', async () => {
    const status = await withEnv('production', async ({ route }) =>
      (await route.POST(nextReq('http://localhost/api/diagnostics/trace', {
        method: 'POST', body: JSON.stringify({ events: [] }), headers: { 'content-type': 'application/json' },
      }))).status
    );
    expect(status).toBe(404);
  });

  it('DELETE does not exist in production', async () => {
    const status = await withEnv('production', async ({ route }) => (await route.DELETE()).status);
    expect(status).toBe(404);
  });

  it('production emits nothing at all — no event reaches any sink', async () => {
    const count = await withEnv('production', ({ events }) => {
      events.clearEvents();
      events.emit({ eventName: 'Accounts.PageViewed', traceId: 'a'.repeat(32), severity: 'error' });
      events.emit({ eventName: 'Accounts.LoadCompleted', traceId: 'a'.repeat(32) });
      return events.recentEvents().length;
    });
    expect(count).toBe(0);
  });

  it('production reports diagnostics as disabled, so the dev panel renders nothing', async () => {
    expect(await withEnv('production', ({ events }) => events.isEnabled())).toBe(false);
  });
});

describe('development availability', () => {
  it('the endpoint exists and round-trips a trace in development', async () => {
    const body = await withEnv('development', async ({ route }) => {
      const traceId = 'b'.repeat(32);
      await route.POST(nextReq('http://localhost/api/diagnostics/trace', {
        method: 'POST',
        headers: { 'content-type': 'application/json', traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
        body: JSON.stringify({ events: [{ timestamp: new Date().toISOString(), traceId, eventName: 'Accounts.PageViewed', eventCategory: 'activity', severity: 'info', route: '/accounts', component: 'AccountsPage', environment: 'development', application: 'cashflow-forecast' }] }),
      }));
      const res = await route.GET(nextReq(`http://localhost/api/diagnostics/trace?traceId=${traceId}`));
      return res.json();
    });

    expect(body.found).toBe(true);
    // the browser event AND the server's own ingest event, under one trace id
    expect(body.events.map((e: { eventName: string }) => e.eventName)).toEqual(
      expect.arrayContaining(['Accounts.PageViewed', 'Diagnostics.Ingested'])
    );
    expect(body.summary.routes).toContain('/accounts');
  });

  it('diagnostics are enabled in development', async () => {
    expect(await withEnv('development', ({ events }) => events.isEnabled())).toBe(true);
  });

  it('an explicit "off" level silences diagnostics even in development', async () => {
    const previous = process.env.NEXT_PUBLIC_OBS_LEVEL;
    process.env.NEXT_PUBLIC_OBS_LEVEL = 'off';
    try {
      expect(await withEnv('development', ({ events }) => events.isEnabled())).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_OBS_LEVEL;
      else process.env.NEXT_PUBLIC_OBS_LEVEL = previous;
    }
  });

  it('the ingest endpoint redacts a secret the browser should never have sent', async () => {
    const body = await withEnv('development', async ({ route }) => {
      const traceId = 'c'.repeat(32);
      await route.POST(nextReq('http://localhost/api/diagnostics/trace', {
        method: 'POST',
        headers: { 'content-type': 'application/json', traceparent: `00-${traceId}-00f067aa0ba902b7-01` },
        body: JSON.stringify({ events: [{ timestamp: new Date().toISOString(), traceId, eventName: 'X', eventCategory: 'activity', severity: 'info', metadata: { accessUrl: 'https://u:leaked@bridge.simplefin.test', accountNumber: '4111111111111234' } }] }),
      }));
      return (await route.GET(nextReq(`http://localhost/api/diagnostics/trace?traceId=${traceId}`))).json();
    });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('leaked');
    expect(serialized).toContain('****1234');
  });
});
