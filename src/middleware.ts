/**
 * Trace correlation for every request Next.js actually serves (documents + route
 * handlers). Continues an inbound W3C `traceparent`, mints one when there is none,
 * and echoes the trace id on the response so a browser — or Playwright — can read it.
 *
 * Headers only. If this ever fails the page still renders; the trace id is just absent.
 *
 * ponytail: Next 16.1 warns that the `middleware` convention is deprecated in favour
 * of `proxy`. It still runs, and renaming is a one-file move — do it when the app next
 * takes a Next major, so this change stays additive and reversible.
 */

import { NextRequest, NextResponse } from 'next/server';
import { continueOrStart, formatTraceparent, newSpanId } from '@/lib/obs/trace';

export function middleware(request: NextRequest): NextResponse {
  const ctx = continueOrStart(request.headers.get('traceparent'));
  const requestId = newSpanId();

  // Downstream (route handlers, server components) read the same context.
  const forwarded = new Headers(request.headers);
  forwarded.set('traceparent', formatTraceparent(ctx));
  forwarded.set('x-request-id', requestId);

  const response = NextResponse.next({ request: { headers: forwarded } });
  response.headers.set('x-trace-id', ctx.traceId);
  response.headers.set('x-request-id', requestId);
  response.headers.set('traceparent', formatTraceparent(ctx));
  // Server-Timing is the one response header a page script can read for its OWN
  // navigation (performance.getEntriesByType('navigation')[0].serverTiming), so this
  // is how the browser CONTINUES the server's trace instead of inventing a new one.
  response.headers.set('Server-Timing', `traceparent;desc="${formatTraceparent(ctx)}"`);
  return response;
}

export const config = {
  // Skip static assets — a trace id on a font file is noise, not signal.
  matcher: ['/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|webp|ico|woff2?)$).*)'],
};
