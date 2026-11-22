// HTTP server for GO's API.
//
// Request order (each step can end the request, and nothing later runs):
//   1. Rate limit by socket remote address. X-Forwarded-For is never read: there is no trusted proxy
//      option yet, so a client cannot choose its own address.
//   2. OPTIONS preflight: answered with 204 and no route runs.
//   3. Route lookup: 404 for an unknown path, 405 for a known path with another method.
//   4. CSRF decision for unsafe methods (see csrf.ts).
//   5. Bearer presence: a 'bearer' route needs an Authorization header of the form "Bearer <token>".
//      The token is passed to the handler unverified. Verifying it is the handler's job (token.ts).
//   6. Body: Content-Length is checked first, then the stream is counted against maxBodyBytes.
//   7. JSON parsing (or the raw string, for rawBody routes).
//   8. The handler. Any exception becomes a generic 500 with no message and no stack.
//
// Every response carries the security headers and the CORS decision.

import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

import { corsDecision, validateAllowedOrigins } from './cors.ts';
import { csrfDecision } from './csrf.ts';
import { FixedWindowLimiter } from './rate-limit.ts';
import { securityHeaders } from './security-headers.ts';

export type ServerConfig = {
  readonly allowedOrigins: readonly string[];
  readonly https: boolean;
  readonly maxBodyBytes: number;
  readonly rateLimit: { readonly limit: number; readonly windowSeconds: number };
  readonly sessionCookieName: string;
};

export type RouteContext = {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  // Parsed JSON for normal routes (undefined when the body is empty). The raw string for rawBody routes.
  readonly body: unknown;
  // The raw bearer token, unverified. Present only on 'bearer' routes.
  readonly bearerToken: string | undefined;
  readonly clientIp: string;
};

export type RouteResult = { readonly status: number; readonly body?: unknown };

export type Route = {
  readonly method: string;
  readonly path: string;
  readonly auth: 'public' | 'bearer';
  readonly rawBody?: boolean;
  readonly handler: (ctx: RouteContext) => Promise<RouteResult> | RouteResult;
};

type BodyRead = { kind: 'ok'; text: string } | { kind: 'too_large' } | { kind: 'error' };

const COOKIE_NAME_TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const DIGITS = /^\d+$/;
const BEARER_TOKEN = /^[^\s]+$/;
const INVALID_ORIGIN = ' invalid-origin ';

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function validateConfig(config: ServerConfig): void {
  validateAllowedOrigins(config.allowedOrigins);
  if (typeof config.https !== 'boolean') throw new TypeError('https must be a boolean');
  if (!isPositiveInteger(config.maxBodyBytes)) throw new TypeError('maxBodyBytes must be a positive integer');
  if (typeof config.sessionCookieName !== 'string' || !COOKIE_NAME_TOKEN.test(config.sessionCookieName)) {
    throw new TypeError('sessionCookieName must be a valid cookie name');
  }
  if (typeof config.rateLimit !== 'object' || config.rateLimit === null) {
    throw new TypeError('rateLimit must be { limit, windowSeconds }');
  }
}

// Builds path -> method -> route. Throws on malformed or duplicate routes.
function indexRoutes(routes: readonly Route[]): Map<string, Map<string, Route>> {
  const table = new Map<string, Map<string, Route>>();
  for (const route of routes) {
    if (typeof route.method !== 'string' || route.method.length === 0) {
      throw new TypeError('route method must be a non-empty string');
    }
    if (typeof route.path !== 'string' || !route.path.startsWith('/')) {
      throw new TypeError(`route path must start with "/": ${JSON.stringify(route.path)}`);
    }
    if (route.auth !== 'public' && route.auth !== 'bearer') {
      throw new TypeError(`route auth must be "public" or "bearer": ${JSON.stringify(route.path)}`);
    }
    if (typeof route.handler !== 'function') throw new TypeError('route handler must be a function');

    const method = route.method.toUpperCase();
    const methods = table.get(route.path) ?? new Map<string, Route>();
    if (methods.has(method)) {
      throw new TypeError(`duplicate route ${method} ${route.path}`);
    }
    methods.set(method, route);
    table.set(route.path, methods);
  }
  return table;
}

// Duplicate headers arrive as arrays. An ambiguous Origin is treated as one that matches nothing.
function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function originHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return INVALID_ORIGIN;
  return value;
}

function parseBearer(header: string | undefined): string | undefined {
  if (header === undefined || !header.startsWith('Bearer ')) return undefined;
  const token = header.slice('Bearer '.length);
  return BEARER_TOKEN.test(token) ? token : undefined;
}

function hasSessionCookie(header: string | undefined, name: string): boolean {
  if (header === undefined) return false;
  return header.split(';').some((part) => part.trim().startsWith(`${name}=`));
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<BodyRead> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;

    const finish = (result: BodyRead): void => {
      if (settled) return;
      settled = true;
      req.removeListener('data', onData);
      req.removeListener('end', onEnd);
      req.removeListener('error', onError);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      total += chunk.length;
      if (total > maxBytes) {
        // Stop reading. The caller answers 413 and closes the connection.
        req.pause();
        finish({ kind: 'too_large' });
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish({ kind: 'ok', text: Buffer.concat(chunks).toString('utf8') });
    const onError = (): void => finish({ kind: 'error' });

    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body?: unknown): void {
  const all: Record<string, string> = { ...headers, 'Content-Type': 'application/json; charset=utf-8' };
  if (body === undefined || status === 204) {
    res.writeHead(status, all);
    res.end();
    return;
  }
  const text = JSON.stringify(body);
  all['Content-Length'] = String(Buffer.byteLength(text));
  res.writeHead(status, all);
  res.end(text);
}

export function createServer(config: ServerConfig, routes: readonly Route[]): Server {
  validateConfig(config);
  const table = indexRoutes(routes);
  const limiter = new FixedWindowLimiter(config.rateLimit);
  const baseHeaders = securityHeaders({ https: config.https });

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const method = (req.method ?? 'GET').toUpperCase();
    const origin = originHeader(req.headers.origin);
    const cors = corsDecision(origin, method, { allowedOrigins: config.allowedOrigins });
    const common: Record<string, string> = { ...baseHeaders, ...cors.headers };
    const clientIp = req.socket.remoteAddress ?? 'unknown';

    const limit = limiter.check(clientIp);
    if (!limit.allowed) {
      send(res, 429, { ...common, 'Retry-After': String(limit.retryAfterSeconds) }, { error: 'rate_limited' });
      return;
    }

    if (method === 'OPTIONS') {
      send(res, 204, common);
      return;
    }

    const rawUrl = req.url ?? '/';
    const queryStart = rawUrl.indexOf('?');
    const path = queryStart === -1 ? rawUrl : rawUrl.slice(0, queryStart);
    const query = new URLSearchParams(queryStart === -1 ? '' : rawUrl.slice(queryStart + 1));

    const methods = table.get(path);
    if (methods === undefined) {
      send(res, 404, common, { error: 'not_found' });
      return;
    }
    const route = methods.get(method);
    if (route === undefined) {
      send(res, 405, { ...common, Allow: [...methods.keys()].join(', ') }, { error: 'method_not_allowed' });
      return;
    }

    const csrf = csrfDecision({
      method,
      origin,
      secFetchSite: singleHeader(req.headers['sec-fetch-site']),
      cookieSessionPresent: hasSessionCookie(singleHeader(req.headers.cookie), config.sessionCookieName),
      allowedOrigins: config.allowedOrigins,
    });
    if (!csrf.allowed) {
      send(res, 403, common, { error: 'forbidden' });
      return;
    }

    let bearerToken: string | undefined;
    if (route.auth === 'bearer') {
      bearerToken = parseBearer(singleHeader(req.headers.authorization));
      if (bearerToken === undefined) {
        send(res, 401, { ...common, 'WWW-Authenticate': 'Bearer' }, { error: 'unauthorized' });
        return;
      }
    }

    const declared = singleHeader(req.headers['content-length']);
    if (declared !== undefined) {
      if (!DIGITS.test(declared)) {
        send(res, 400, common, { error: 'bad_request' });
        return;
      }
      if (Number(declared) > config.maxBodyBytes) {
        send(res, 413, { ...common, Connection: 'close' }, { error: 'payload_too_large' });
        return;
      }
    }

    const read = await readBody(req, config.maxBodyBytes);
    if (read.kind === 'too_large') {
      send(res, 413, { ...common, Connection: 'close' }, { error: 'payload_too_large' });
      return;
    }
    if (read.kind === 'error') {
      send(res, 400, common, { error: 'bad_request' });
      return;
    }

    let body: unknown;
    if (route.rawBody === true) {
      body = read.text;
    } else if (read.text.length > 0) {
      try {
        body = JSON.parse(read.text);
      } catch {
        send(res, 400, common, { error: 'invalid_json' });
        return;
      }
    }

    let result: RouteResult;
    try {
      result = await route.handler({
        method,
        path,
        query,
        body,
        bearerToken,
        clientIp,
      });
    } catch {
      // No message, no stack. The error is not logged here because it may carry request data.
      send(res, 500, common, { error: 'internal_error' });
      return;
    }
    if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) {
      send(res, 500, common, { error: 'internal_error' });
      return;
    }
    send(res, result.status, common, result.body);
  };

  return createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { ...baseHeaders, Vary: 'Origin' }, { error: 'internal_error' });
      else res.destroy();
    });
  });
}
