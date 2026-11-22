import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer } from '../src/server.ts';
import type { Route, ServerConfig } from '../src/server.ts';
import { corsDecision } from '../src/cors.ts';
import { csrfDecision } from '../src/csrf.ts';
import { FixedWindowLimiter } from '../src/rate-limit.ts';
import { securityHeaders } from '../src/security-headers.ts';

const ORIGIN = 'https://app.example.test';
const EVIL_ORIGIN = 'https://evil.example.test';
const SESSION_COOKIE = 'go_session';
const LEAKY_MESSAGE = 'db password=hunter2 at /srv/secret/handler.ts:10';

const baseConfig: ServerConfig = {
  allowedOrigins: [ORIGIN],
  https: false,
  maxBodyBytes: 1024,
  rateLimit: { limit: 1000, windowSeconds: 60 },
  sessionCookieName: SESSION_COOKIE,
};

const routes: Route[] = [
  { method: 'GET', path: '/health', auth: 'public', handler: () => ({ status: 200, body: { ok: true } }) },
  {
    method: 'POST',
    path: '/echo',
    auth: 'public',
    handler: (ctx) => ({ status: 200, body: { received: ctx.body ?? null } }),
  },
  {
    method: 'POST',
    path: '/raw',
    auth: 'public',
    rawBody: true,
    handler: (ctx) => ({ status: 200, body: { type: typeof ctx.body, value: ctx.body } }),
  },
  {
    method: 'POST',
    path: '/write',
    auth: 'bearer',
    handler: (ctx) => ({ status: 200, body: { token: ctx.bearerToken } }),
  },
  { method: 'GET', path: '/me', auth: 'bearer', handler: (ctx) => ({ status: 200, body: { token: ctx.bearerToken } }) },
  {
    method: 'GET',
    path: '/boom',
    auth: 'public',
    handler: () => {
      throw new Error(LEAKY_MESSAGE);
    },
  },
];

type Running = { server: Server; base: string };

async function start(config: ServerConfig, routeList: readonly Route[] = routes): Promise<Running> {
  const server = createServer(config, routeList);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { server, base: `http://127.0.0.1:${port}` };
}

function stop(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.closeAllConnections();
    server.close((err: Error | undefined) => (err ? reject(err) : resolve()));
  });
}

describe('HTTP baseline', () => {
  let main: Running;
  let secure: Running;

  before(async () => {
    main = await start(baseConfig);
    secure = await start({ ...baseConfig, https: true });
  });

  after(async () => {
    await stop(main.server);
    await stop(secure.server);
  });

  describe('security headers', () => {
    test('every successful response carries the baseline headers', async () => {
      const res = await fetch(`${main.base}/health`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-security-policy'), "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('permissions-policy'), 'camera=(), microphone=(), geolocation=(), payment=()');
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
      assert.equal(res.headers.get('cache-control'), 'no-store');
    });

    test('HSTS is absent when https is false', async () => {
      const res = await fetch(`${main.base}/health`);
      assert.equal(res.headers.get('strict-transport-security'), null);
    });

    test('HSTS is present when https is true', async () => {
      const res = await fetch(`${secure.base}/health`);
      assert.equal(res.headers.get('strict-transport-security'), 'max-age=63072000; includeSubDomains');
    });

    test('headers are present on error responses too', async () => {
      const res = await fetch(`${main.base}/nope`);
      assert.equal(res.status, 404);
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
    });

    test('securityHeaders only adds HSTS when asked', () => {
      assert.equal('Strict-Transport-Security' in securityHeaders({ https: false }), false);
      assert.equal('Strict-Transport-Security' in securityHeaders({ https: true }), true);
    });
  });

  describe('CORS', () => {
    test('an allowed origin gets Access-Control-Allow-Origin and credentials', async () => {
      const res = await fetch(`${main.base}/health`, { headers: { Origin: ORIGIN } });
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
      assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
      assert.match(res.headers.get('vary') ?? '', /Origin/);
    });

    test('a disallowed origin gets no Access-Control-Allow-Origin header', async () => {
      const res = await fetch(`${main.base}/health`, { headers: { Origin: EVIL_ORIGIN } });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.equal(res.headers.get('access-control-allow-credentials'), null);
      assert.match(res.headers.get('vary') ?? '', /Origin/);
    });

    test('a preflight from an allowed origin is answered with methods and headers', async () => {
      const res = await fetch(`${main.base}/echo`, { method: 'OPTIONS', headers: { Origin: ORIGIN } });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-origin'), ORIGIN);
      assert.match(res.headers.get('access-control-allow-methods') ?? '', /POST/);
      assert.equal(res.headers.get('access-control-allow-headers'), 'Authorization, Content-Type');
    });

    test('a preflight from an unlisted origin gets no CORS grant', async () => {
      const res = await fetch(`${main.base}/echo`, { method: 'OPTIONS', headers: { Origin: EVIL_ORIGIN } });
      assert.equal(res.headers.get('access-control-allow-origin'), null);
      assert.equal(res.headers.get('access-control-allow-methods'), null);
      assert.equal(res.headers.get('access-control-allow-headers'), null);
    });

    test('the wildcard is never sent', async () => {
      const res = await fetch(`${main.base}/health`, { headers: { Origin: EVIL_ORIGIN } });
      assert.notEqual(res.headers.get('access-control-allow-origin'), '*');
    });
  });

  describe('CSRF', () => {
    test('a cross-site unsafe request is refused', async () => {
      const res = await fetch(`${main.base}/echo`, {
        method: 'POST',
        headers: { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 403);
    });

    test('an unsafe request from a disallowed origin is refused', async () => {
      const res = await fetch(`${main.base}/echo`, {
        method: 'POST',
        headers: { Origin: EVIL_ORIGIN, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 403);
    });

    test('a cookie session with no Origin is refused', async () => {
      const res = await fetch(`${main.base}/echo`, {
        method: 'POST',
        headers: { Cookie: `${SESSION_COOKIE}=opaque-session-value`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 403);
    });

    test('a cookie session from an allowed origin is accepted', async () => {
      const res = await fetch(`${main.base}/echo`, {
        method: 'POST',
        headers: { Origin: ORIGIN, Cookie: `${SESSION_COOKIE}=opaque-session-value`, 'Content-Type': 'application/json' },
        body: '{}',
      });
      assert.equal(res.status, 200);
    });

    test('a bearer-only unsafe request with no Origin is not subject to the cookie rule', async () => {
      const res = await fetch(`${main.base}/write`, {
        method: 'POST',
        headers: { Authorization: 'Bearer abc.def.ghi' },
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { token: 'abc.def.ghi' });
    });

    test('safe methods are never refused on CSRF grounds', async () => {
      const res = await fetch(`${main.base}/health`, {
        headers: { 'Sec-Fetch-Site': 'cross-site', Origin: EVIL_ORIGIN, Cookie: `${SESSION_COOKIE}=x` },
      });
      assert.equal(res.status, 200);
    });
  });

  describe('authentication presence', () => {
    test('a bearer route with no Authorization header is 401', async () => {
      const res = await fetch(`${main.base}/me`);
      assert.equal(res.status, 401);
      assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    });

    test('a non-Bearer Authorization scheme is 401', async () => {
      const res = await fetch(`${main.base}/me`, { headers: { Authorization: 'Basic dXNlcjpwYXNz' } });
      assert.equal(res.status, 401);
    });

    test('an empty bearer token is 401', async () => {
      const res = await fetch(`${main.base}/me`, { headers: { Authorization: 'Bearer ' } });
      assert.equal(res.status, 401);
    });

    test('a bearer token is passed to the handler unverified', async () => {
      const res = await fetch(`${main.base}/me`, { headers: { Authorization: 'Bearer raw-token-value' } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { token: 'raw-token-value' });
    });
  });

  describe('bodies and JSON', () => {
    test('a Content-Length over the limit is 413', async () => {
      const res = await fetch(`${main.base}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ padding: 'x'.repeat(2000) }),
      });
      assert.equal(res.status, 413);
    });

    test('a streamed body over the limit (no Content-Length) is 413', async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(JSON.stringify({ padding: 'y'.repeat(3000) })));
          controller.close();
        },
      });
      const init = { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' };
      const res = await fetch(`${main.base}/echo`, init as RequestInit);
      assert.equal(res.status, 413);
    });

    test('a body under the limit is parsed as JSON', async () => {
      const res = await fetch(`${main.base}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: 42 }),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { received: { amount: 42 } });
    });

    test('an empty body gives the handler no body', async () => {
      const res = await fetch(`${main.base}/echo`, { method: 'POST' });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { received: null });
    });

    test('invalid JSON is 400', async () => {
      const res = await fetch(`${main.base}/echo`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"unterminated": ',
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: 'invalid_json' });
    });

    test('a rawBody route receives the unparsed string', async () => {
      const res = await fetch(`${main.base}/raw`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: '{"a":1}',
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { type: 'string', value: '{"a":1}' });
    });
  });

  describe('routing and errors', () => {
    test('an unknown route is 404', async () => {
      const res = await fetch(`${main.base}/does-not-exist`);
      assert.equal(res.status, 404);
      assert.deepEqual(await res.json(), { error: 'not_found' });
    });

    test('a known path with the wrong method is 405 with Allow', async () => {
      const res = await fetch(`${main.base}/health`, { method: 'POST' });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET');
    });

    test('a throwing handler is a generic 500 with no message or stack', async () => {
      const res = await fetch(`${main.base}/boom`);
      assert.equal(res.status, 500);
      const text = await res.text();
      assert.equal(text, '{"error":"internal_error"}');
      assert.equal(text.includes('hunter2'), false);
      assert.equal(text.includes('handler.ts'), false);
      assert.equal(text.includes(' at '), false);
    });

    test('JSON responses use the exact content type', async () => {
      const res = await fetch(`${main.base}/health`);
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    });

    test('the query string is not part of the route match', async () => {
      const res = await fetch(`${main.base}/health?x=1`);
      assert.equal(res.status, 200);
    });
  });
});

describe('rate limiting over HTTP', () => {
  let limited: Running;

  before(async () => {
    limited = await start({ ...baseConfig, rateLimit: { limit: 3, windowSeconds: 60 } });
  });

  after(async () => {
    await stop(limited.server);
  });

  test('requests beyond the limit get 429 with Retry-After', async () => {
    for (let i = 0; i < 3; i += 1) {
      const ok = await fetch(`${limited.base}/health`);
      assert.equal(ok.status, 200);
    }
    const res = await fetch(`${limited.base}/health`);
    assert.equal(res.status, 429);
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.equal(Number.isInteger(retryAfter) && retryAfter >= 1 && retryAfter <= 60, true);
    assert.deepEqual(await res.json(), { error: 'rate_limited' });
  });
});

describe('construction', () => {
  test('createServer rejects a wildcard origin', () => {
    assert.throws(() => createServer({ ...baseConfig, allowedOrigins: ['*'] }, routes), TypeError);
    assert.throws(() => createServer({ ...baseConfig, allowedOrigins: ['https://*.example.test'] }, routes), TypeError);
  });

  test('createServer rejects an origin with a path or trailing slash', () => {
    assert.throws(() => createServer({ ...baseConfig, allowedOrigins: ['https://app.example.test/'] }, routes), TypeError);
    assert.throws(() => createServer({ ...baseConfig, allowedOrigins: ['https://app.example.test/x'] }, routes), TypeError);
  });

  test('corsDecision refuses a wildcard origin at call time', () => {
    assert.throws(() => corsDecision(ORIGIN, 'GET', { allowedOrigins: ['*'] }), TypeError);
  });

  test('createServer rejects invalid required settings', () => {
    assert.throws(() => createServer({ ...baseConfig, maxBodyBytes: 0 }, routes), TypeError);
    assert.throws(() => createServer({ ...baseConfig, https: 'yes' as never }, routes), TypeError);
    assert.throws(() => createServer({ ...baseConfig, sessionCookieName: 'bad name' }, routes), TypeError);
    assert.throws(() => createServer({ ...baseConfig, rateLimit: { limit: 0, windowSeconds: 60 } }, routes), TypeError);
  });

  test('createServer rejects duplicate routes', () => {
    const dup: Route[] = [
      { method: 'GET', path: '/x', auth: 'public', handler: () => ({ status: 200 }) },
      { method: 'get', path: '/x', auth: 'public', handler: () => ({ status: 200 }) },
    ];
    assert.throws(() => createServer(baseConfig, dup), TypeError);
  });
});

describe('csrfDecision and corsDecision (pure)', () => {
  test('safe methods are always allowed', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.equal(
        csrfDecision({
          method,
          origin: EVIL_ORIGIN,
          secFetchSite: 'cross-site',
          cookieSessionPresent: true,
          allowedOrigins: [ORIGIN],
        }).allowed,
        true,
      );
    }
  });

  test('an unsafe request with no Origin and no cookie is allowed', () => {
    assert.deepEqual(
      csrfDecision({ method: 'POST', origin: undefined, secFetchSite: undefined, cookieSessionPresent: false, allowedOrigins: [ORIGIN] }),
      { allowed: true, reason: null },
    );
  });

  test('a preflight decision is reported as preflight and grants nothing to an unlisted origin', () => {
    const decision = corsDecision(EVIL_ORIGIN, 'OPTIONS', { allowedOrigins: [ORIGIN] });
    assert.equal(decision.preflight, true);
    assert.equal(decision.allowed, false);
    assert.equal('Access-Control-Allow-Origin' in decision.headers, false);
  });
});

describe('FixedWindowLimiter', () => {
  test('allows up to the limit, then refuses until the window passes', () => {
    let clock = 1_000_000;
    const limiter = new FixedWindowLimiter({ limit: 2, windowSeconds: 10 }, () => clock);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('a').allowed, true);
    const refused = limiter.check('a');
    assert.equal(refused.allowed, false);
    assert.equal(refused.retryAfterSeconds, 10);

    clock += 4_000;
    assert.equal(limiter.check('a').retryAfterSeconds, 6);

    clock += 6_000;
    assert.equal(limiter.check('a').allowed, true);
  });

  test('keys are counted independently', () => {
    const limiter = new FixedWindowLimiter({ limit: 1, windowSeconds: 60 }, () => 0);
    assert.equal(limiter.check('a').allowed, true);
    assert.equal(limiter.check('b').allowed, true);
    assert.equal(limiter.check('a').allowed, false);
  });

  test('rejects a non-positive or non-integer limit or window', () => {
    assert.throws(() => new FixedWindowLimiter({ limit: 0, windowSeconds: 60 }), TypeError);
    assert.throws(() => new FixedWindowLimiter({ limit: 1.5, windowSeconds: 60 }), TypeError);
    assert.throws(() => new FixedWindowLimiter({ limit: 1, windowSeconds: -1 }), TypeError);
    assert.throws(() => new FixedWindowLimiter({ limit: 1, windowSeconds: Number.NaN }), TypeError);
  });
});
