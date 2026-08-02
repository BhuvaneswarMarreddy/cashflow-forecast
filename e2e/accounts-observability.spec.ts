/**
 * OBS-001 — Accounts observability validation.
 *
 * Opens the real Accounts page against sanitized fixtures, captures browser evidence,
 * extracts the response trace id, and proves the backend holds evidence under the SAME
 * trace id. Read-only throughout: it never signs in, never refreshes SimpleFIN, never
 * writes, and asserts that no request to a live Firebase/Google endpoint was made.
 */

import { test, expect, Request, ConsoleMessage } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const FIXTURE_ROUTE = '/dev/accounts-fixture';
const EVIDENCE_ROOT = 'test-results/observability';

/** Anything matching these must never appear in a captured artifact. */
const SECRET_PATTERNS: Array<[string, RegExp]> = [
  ['url-with-credentials', /[a-z]+:\/\/[^\s/@]+:[^\s/@]+@/i],
  ['bearer-token', /Bearer\s+[A-Za-z0-9._~+/=-]{8,}/],
  ['jwt', /eyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/],
  ['openai-key', /sk-[A-Za-z0-9_-]{16,}/],
  ['long-digit-run', /\b\d{12,19}\b/],
  ['connection-string', /(?:postgres|mysql|mongodb)(?:\+srv)?:\/\//i],
];

/** Live-data tripwire: the automated test must never reach the real project. */
const LIVE_ENDPOINTS = /firestore\.googleapis\.com|identitytoolkit\.googleapis\.com|securetoken\.googleapis\.com|cloudfunctions\.net|bridge\.simplefin\.org/;

test.describe('Accounts observability', () => {
  test('one trace links the UI, the API and the backend evidence', async ({ page, request }, testInfo) => {
    const consoleMessages: Array<{ type: string; text: string }> = [];
    const failedRequests: Array<{ url: string; failure: string }> = [];
    const networkLog: Array<{ method: string; url: string; status: number | null; resourceType: string }> = [];
    const liveHits: string[] = [];

    page.on('console', (m: ConsoleMessage) => {
      if (['error', 'warning'].includes(m.type())) consoleMessages.push({ type: m.type(), text: m.text() });
    });
    page.on('requestfailed', (r: Request) => failedRequests.push({ url: r.url(), failure: r.failure()?.errorText ?? 'unknown' }));
    page.on('request', (r: Request) => { if (LIVE_ENDPOINTS.test(r.url())) liveHits.push(r.url()); });
    page.on('response', (r) => {
      const url = r.url();
      if (url.startsWith('data:') || /\.(png|jpe?g|svg|woff2?|css)$/.test(url)) return;
      networkLog.push({ method: r.request().method(), url, status: r.status(), resourceType: r.request().resourceType() });
    });

    // 1. Open the Accounts page (fixture-backed) and capture the document response.
    const response = await page.goto(FIXTURE_ROUTE, { waitUntil: 'domcontentloaded' });
    expect(response, 'document response').toBeTruthy();
    expect(response!.status()).toBe(200);

    // 2. The middleware exposes a safe trace id on the response.
    const headerTraceId = response!.headers()['x-trace-id'];
    expect(headerTraceId, 'X-Trace-Id response header').toMatch(/^[0-9a-f]{32}$/);
    expect(response!.headers()['traceparent']).toContain(headerTraceId);

    // 3. The Accounts UI actually rendered its headline numbers.
    await expect(page.getByText('Net Worth')).toBeVisible();
    await expect(page.getByText('Bank Balance')).toBeVisible();

    // 4. The page publishes the trace id it used for this operation.
    const traceLocator = page.getByTestId('accounts-trace-id');
    await expect(traceLocator).toBeVisible();
    const uiTraceId = (await traceLocator.innerText()).trim();
    expect(uiTraceId, 'trace id rendered by the page').toMatch(/^[0-9a-f]{32}$/);

    // The browser CONTINUES the document's server trace rather than inventing one.
    expect(uiTraceId, 'browser trace continues the server trace').toBe(headerTraceId);

    // 5. Provenance is available to the page, sanitized.
    const provenance = await page.evaluate(() => (window as any).__OBS__?.provenance ?? null);
    expect(provenance, 'provenance summary').toBeTruthy();
    expect(provenance.calculationName).toBe('AccountsSummary');
    expect(provenance.calculationVersion).toBe('v1');
    expect(provenance.metrics.map((m: { metric: string }) => m.metric))
      .toEqual(expect.arrayContaining(['BankBalance', 'CreditUsed', 'NetWorth', 'AccountCount']));
    expect(provenance.traceId).toBe(uiTraceId);

    // Provenance is rendered, not just held in memory.
    await page.getByTestId('accounts-diagnostics').getByRole('group').or(page.getByTestId('accounts-diagnostics')).first().click();
    await expect(page.getByTestId('provenance-BankBalance')).toBeVisible();

    // 6. The browser shipped its events to the backend over a real HTTP hop.
    await page.evaluate(() => (window as any).__OBS__?.flush?.());
    const ingest = networkLog.filter((n) => n.url.includes('/api/diagnostics/trace'));
    await expect.poll(async () => {
      await page.evaluate(() => (window as any).__OBS__?.flush?.());
      return networkLog.filter((n) => n.url.includes('/api/diagnostics/trace')).length;
    }, { timeout: 10_000 }).toBeGreaterThan(0);

    // 7. Backend evidence exists under the SAME trace id.
    const diagnostics = await request.get(`/api/diagnostics/trace?traceId=${uiTraceId}`);
    expect(diagnostics.ok()).toBeTruthy();
    const bundle = await diagnostics.json();

    expect(bundle.found, `backend evidence for trace ${uiTraceId}`).toBe(true);
    expect(bundle.traceId).toBe(uiTraceId);

    const eventNames: string[] = bundle.events.map((e: { eventName: string }) => e.eventName);
    expect(eventNames, 'frontend activity events').toEqual(expect.arrayContaining([
      'Accounts.PageViewed', 'Accounts.LoadStarted', 'Accounts.LoadCompleted',
    ]));
    expect(eventNames, 'backend endpoint event').toContain('Diagnostics.Ingested');
    expect(bundle.summary.routes).toContain('/accounts');
    expect(bundle.events.every((e: { traceId: string }) => e.traceId === uiTraceId)).toBe(true);

    // 8. No live financial endpoint was contacted by the automated run.
    expect(liveHits, 'requests to live Firebase/SimpleFIN endpoints').toEqual([]);

    // 9. No obvious secret in anything we captured.
    const captured = JSON.stringify({ consoleMessages, failedRequests, networkLog, bundle, provenance });
    for (const [name, pattern] of SECRET_PATTERNS) {
      expect(pattern.test(captured), `captured artifacts contain ${name}`).toBe(false);
    }

    // 10. Retain the evidence, keyed by trace id, for the bundle exporter.
    const dir = join(EVIDENCE_ROOT, uiTraceId);
    mkdirSync(dir, { recursive: true });
    // Fixture data only — safe to keep. A run against real data must never be committed.
    await page.screenshot({ path: join(dir, 'accounts.png'), fullPage: true });
    writeFileSync(join(dir, 'frontend-events.jsonl'),
      bundle.events.filter((e: { component?: string }) => e.component).map((e: unknown) => JSON.stringify(e)).join('\n'));
    writeFileSync(join(dir, 'backend-events.jsonl'),
      bundle.events.filter((e: { endpoint?: string }) => e.endpoint).map((e: unknown) => JSON.stringify(e)).join('\n'));
    writeFileSync(join(dir, 'provenance.json'), JSON.stringify(provenance, null, 2));
    writeFileSync(join(dir, 'network-summary.json'), JSON.stringify({ requests: networkLog, failed: failedRequests }, null, 2));
    writeFileSync(join(dir, 'console-summary.txt'),
      consoleMessages.map((m) => `[${m.type}] ${m.text}`).join('\n') || '(no console errors or warnings)');
    writeFileSync(join(dir, 'trace-summary.json'), JSON.stringify({
      traceId: uiTraceId,
      responseHeaderTraceId: headerTraceId,
      dataSource: 'fixture (/dev/accounts-fixture) — no live Firestore read',
      route: FIXTURE_ROUTE,
      eventCount: bundle.eventCount,
      summary: bundle.summary,
    }, null, 2));

    testInfo.annotations.push({ type: 'trace-id', description: uiTraceId });
    // Printed so a CI log makes the trace findable without opening an artifact.
    console.log(`Primary Trace ID: ${uiTraceId}`);
    console.log(`Diagnostic Artifact: ${dir}`);

    // Accounts data itself loaded cleanly.
    expect(failedRequests.filter((r) => !r.url.includes('favicon')), 'failed network requests').toEqual([]);
    expect(ingest.every((n) => n.status === null || n.status! < 400)).toBe(true);
  });

  test('the diagnostics endpoint reports an unknown trace honestly', async ({ request }) => {
    const res = await request.get(`/api/diagnostics/trace?traceId=${'f'.repeat(32)}`);
    expect(res.ok()).toBeTruthy();
    const body = await res.json();
    expect(body.found).toBe(false);
    expect(body.events).toEqual([]);
  });
});
