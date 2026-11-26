// The search service's HTTP app. It reuses packages/http for the request pipeline and
// packages/flights for validation, supplier calls and the search outcome.
//
// Routes:
//   GET  /health              200 { status: "ok" }. No detail about suppliers or configuration.
//   POST /api/flights/search  Body: a search (one-way, return or multi-city). Responses:
//     200 { status: "ok" | "empty", source, offers }
//     422 { status: "invalid", errors }                  field messages, never echoed input
//     503 { status: "unavailable", reason, source, message }   not configured, or FX unavailable
//     504 { status: "unavailable", reason: "timeout", ... }
//     502 { status: "unavailable", reason, ... }         provider failure or unusable response
//
// Nothing a supplier sends back is placed in an error message. Each unavailable state uses a fixed
// message written here, so a provider's text or a stack trace cannot reach the browser.

import type { Server } from 'node:http';

import { createServer, type Route, type RouteContext, type RouteResult } from '../../../packages/http/src/server.ts';
import { DuffelFlightSupplier, type HttpTransport } from '../../../packages/flights/src/adapters/duffel.ts';
import { parseSearchInput } from '../../../packages/flights/src/search-input.ts';
import { runFlightSearch, type SearchOutcome } from '../../../packages/flights/src/search-service.ts';
import { SupplierUnavailableError, type FlightSupplier } from '../../../packages/flights/src/supplier.ts';
import type { SearchConfig } from './config.ts';
import { logEvent, stdoutSink, type LogSink } from './logger.ts';

export const HEALTH_PATH = '/health';
export const SEARCH_PATH = '/api/flights/search';
// Unused by this service (it holds no sessions). The HTTP layer requires a name, so one is given.
const SESSION_COOKIE_NAME = 'go_search_session';

export type SearchSupplier = Pick<FlightSupplier, 'name' | 'mode' | 'search' | 'searchDetailed'>;

export interface AppOptions {
  // Replaces the configured supplier. Used by tests and never set in production.
  readonly supplier?: SearchSupplier;
  // Replaces the HTTP transport of the Duffel adapter. Used by tests only.
  readonly transport?: HttpTransport;
  readonly now?: () => Date;
  readonly log?: LogSink;
}

// Calls to a supplier that is not configured never reach the network.
class NotConfiguredSupplier implements SearchSupplier {
  readonly name = 'none';
  readonly mode = 'sandbox' as const;
  async search(): Promise<never> {
    throw new SupplierUnavailableError('not_configured', 'No flight supplier is configured');
  }
}

export function buildSupplier(config: SearchConfig, transport?: AppOptions['transport']): SearchSupplier {
  if (config.supplier.kind === 'none') return new NotConfiguredSupplier();
  // Sandbox only. The service has no production option, so production cannot be enabled by config.
  return new DuffelFlightSupplier({
    mode: 'sandbox',
    accessToken: config.supplier.accessToken,
    timeoutMs: config.supplierTimeoutMs,
    ...(transport === undefined ? {} : { transport }),
  });
}

// Today's date in Lagos, the same rule the web app uses.
export function todayInLagos(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

// Fixed text per reason. A provider's own message is never used.
const SAFE_MESSAGE: Readonly<Record<string, string>> = {
  not_configured: 'Flight search is not connected yet.',
  production_not_approved: 'Flight search is not connected yet.',
  timeout: 'The flight provider did not respond in time. Try again.',
  provider_error: 'The flight provider is unavailable right now. Try again later.',
  invalid_response: 'The flight provider returned results we could not use. Try again later.',
  fx_unavailable: 'Prices are not available right now. Try again later.',
};
const FALLBACK_MESSAGE = 'Flight search is unavailable right now.';

function statusForReason(reason: string): number {
  if (reason === 'not_configured' || reason === 'production_not_approved' || reason === 'fx_unavailable') return 503;
  if (reason === 'timeout') return 504;
  return 502;
}

// Races the supplier against a deadline. The HTTP-level timer cannot stop a transport that ignores
// its abort signal, so the deadline is enforced here as well.
function withDeadline<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SupplierUnavailableError('timeout', 'Supplier deadline exceeded')), ms);
  });
  return Promise.race([work, deadline]).finally(() => clearTimeout(timer));
}

// Wraps the supplier so that nothing unexpected escapes. A non-supplier error becomes provider_error.
// Both search methods are wrapped, so the deadline and the error boundary apply whichever one runs.
function guard(supplier: SearchSupplier, timeoutMs: number): SearchSupplier {
  const bounded = async <T>(work: () => Promise<T>): Promise<T> => {
    try {
      return await withDeadline(work(), timeoutMs);
    } catch (error) {
      if (error instanceof SupplierUnavailableError) throw error;
      throw new SupplierUnavailableError('provider_error', 'Supplier call failed');
    }
  };
  const detailed = supplier.searchDetailed?.bind(supplier);
  return {
    name: supplier.name,
    mode: supplier.mode,
    search: (request) => bounded(() => supplier.search(request)),
    ...(detailed === undefined ? {} : { searchDetailed: (request) => bounded(() => detailed(request)) }),
  };
}

function outcomeResponse(outcome: SearchOutcome): RouteResult {
  switch (outcome.status) {
    case 'ok':
      return { status: 200, body: { status: 'ok', source: outcome.source, offers: outcome.offers, excluded: outcome.excluded } };
    case 'empty':
      return { status: 200, body: { status: 'empty', source: outcome.source, offers: [], excluded: outcome.excluded } };
    case 'invalid':
      return { status: 422, body: { status: 'invalid', errors: outcome.errors } };
    case 'unavailable':
      return {
        status: statusForReason(outcome.reason),
        body: {
          status: 'unavailable',
          reason: outcome.reason,
          source: outcome.source,
          message: SAFE_MESSAGE[outcome.reason] ?? FALLBACK_MESSAGE,
        },
      };
  }
}

export function createSearchServer(config: SearchConfig, options: AppOptions = {}): Server {
  const log = options.log ?? stdoutSink;
  const now = options.now ?? (() => new Date());
  const supplier = guard(options.supplier ?? buildSupplier(config, options.transport), config.supplierTimeoutMs);

  const record = (route: string, status: number, startedAt: number, outcome?: string, reason?: string): void => {
    logEvent({ event: 'request', route, status, durationMs: Date.now() - startedAt, outcome, reason }, log);
  };

  const health = (): RouteResult => {
    const startedAt = Date.now();
    record('health', 200, startedAt);
    return { status: 200, body: { status: 'ok' } };
  };

  const search = async (ctx: RouteContext): Promise<RouteResult> => {
    const startedAt = Date.now();
    const parsed = parseSearchInput(ctx.body);
    if (!parsed.ok) {
      record('search', 422, startedAt, 'invalid');
      return { status: 422, body: { status: 'invalid', errors: parsed.errors } };
    }
    try {
      const outcome = await runFlightSearch(parsed.input, todayInLagos(now()), supplier);
      const response = outcomeResponse(outcome);
      record('search', response.status, startedAt, outcome.status, outcome.status === 'unavailable' ? outcome.reason : undefined);
      return response;
    } catch {
      // Validation and supplier failures are handled above. Anything else is a bug: log the fact
      // without its details and answer with a generic 500.
      record('search', 500, startedAt, 'internal_error');
      return { status: 500, body: { error: 'internal_error' } };
    }
  };

  const routes: Route[] = [
    // rateLimited: false. The platform's health probe is not counted, so probes cannot get it marked unhealthy.
    { method: 'GET', path: HEALTH_PATH, auth: 'public', credentials: false, rateLimited: false, handler: health },
    // crossSite: the static site is on another host, so the browser marks this request cross-site.
    // The route holds no cookie session and uses no credentials, so the opt-in is safe. The Origin
    // rule still applies.
    { method: 'POST', path: SEARCH_PATH, auth: 'public', crossSite: true, credentials: false, handler: search },
  ];

  const server = createServer(
    {
      allowedOrigins: config.allowedOrigins,
      https: config.https,
      maxBodyBytes: config.maxBodyBytes,
      rateLimit: config.rateLimit,
      sessionCookieName: SESSION_COOKIE_NAME,
    },
    routes,
  );
  // Node's defaults (60 s headers, 300 s request) let a slow client hold a connection for minutes.
  // A search body is small and the supplier deadline is 15 s by default, so shorter limits are safe.
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
