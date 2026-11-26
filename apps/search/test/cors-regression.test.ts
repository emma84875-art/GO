// Regression tests for CORS credentials, exact origins and the CSRF exception.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createSearchServer } from '../src/app.ts';
import type { SearchConfig } from '../src/config.ts';
import { createServer, type Route } from '../../../packages/http/src/server.ts';

const ORIGIN = 'https://go-web.example';
const OTHER = 'https://evil.example';

const config: SearchConfig = {
  port: 0,
  allowedOrigins: [ORIGIN],
  https: true,
  maxBodyBytes: 16_384,
  rateLimit: { limit: 1000, windowSeconds: 60 },
  supplierTimeoutMs: 2000,
  supplier: { kind: 'none' },
};

type Reply = { status: number; headers: Record<string, string | string[] | undefined> };

function call(base: string, path: string, method: string, headers: Record<string, string> = {}, body?: string): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, base), { method, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

async function listen(server: Server): Promise<{ base: string; close: () => Promise<void> }> {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const { port } = server.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => server.close(() => resolve())) };
}

const searchBody = JSON.stringify({
  tripType: 'one_way',
  origin: 'LOS',
  destination: 'LHR',
  departureDate: '2026-12-01',
  passengers: { adults: 1 },
  cabin: 'economy',
  displayCurrency: 'USD',
});

describe('search service CORS regression', () => {
  let running: { base: string; close: () => Promise<void> };
  before(async () => {
    running = await listen(createSearchServer(config, { log: () => undefined, supplier: { name: 'fake', mode: 'sandbox', search: async () => [] } }));
  });
  after(async () => {
    await running.close();
  });

  test('a POST from a listed origin gets that origin back and no credentials header', async () => {
    const reply = await call(running.base, '/api/flights/search', 'POST', { Origin: ORIGIN, 'Content-Type': 'application/json' }, searchBody);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(reply.headers['access-control-allow-credentials'], undefined);
  });

  test('the preflight for the search route has no credentials header', async () => {
    const reply = await call(running.base, '/api/flights/search', 'OPTIONS', { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' });
    assert.equal(reply.status, 204);
    assert.equal(reply.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(reply.headers['access-control-allow-credentials'], undefined);
    assert.ok(String(reply.headers['access-control-allow-methods']).includes('POST'));
  });

  test('health has no credentials header either', async () => {
    const reply = await call(running.base, '/health', 'GET', { Origin: ORIGIN });
    assert.equal(reply.headers['access-control-allow-origin'], ORIGIN);
    assert.equal(reply.headers['access-control-allow-credentials'], undefined);
  });

  test('an unlisted origin gets no allow-origin and no credentials header, never a wildcard', async () => {
    const preflight = await call(running.base, '/api/flights/search', 'OPTIONS', { Origin: OTHER, 'Access-Control-Request-Method': 'POST' });
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
    assert.equal(preflight.headers['access-control-allow-credentials'], undefined);
    const post = await call(running.base, '/api/flights/search', 'POST', { Origin: OTHER, 'Content-Type': 'application/json' }, searchBody);
    assert.equal(post.status, 403);
    assert.equal(post.headers['access-control-allow-origin'], undefined);
    assert.notEqual(post.headers['access-control-allow-origin'], '*');
  });

  test('a cross-site POST is accepted from the listed origin on the search route only', async () => {
    const reply = await call(running.base, '/api/flights/search', 'POST', { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, searchBody);
    assert.equal(reply.status, 200);
  });

  test('a cross-site POST with an unlisted origin is still refused on the search route', async () => {
    const reply = await call(running.base, '/api/flights/search', 'POST', { Origin: OTHER, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, searchBody);
    assert.equal(reply.status, 403);
  });
});

describe('CSRF exception stays on the search route', () => {
  test('another public POST route still refuses cross-site, and keeps its credentials header', async () => {
    const routes: Route[] = [{ method: 'POST', path: '/elsewhere', auth: 'public', handler: () => ({ status: 200, body: {} }) }];
    const server = createServer(
      { allowedOrigins: [ORIGIN], https: true, maxBodyBytes: 16_384, rateLimit: { limit: 1000, windowSeconds: 60 }, sessionCookieName: 'go_test' },
      routes,
    );
    const open = await listen(server);
    try {
      const refused = await call(open.base, '/elsewhere', 'POST', { Origin: ORIGIN, 'Sec-Fetch-Site': 'cross-site', 'Content-Type': 'application/json' }, '{}');
      assert.equal(refused.status, 403);
      const ok = await call(open.base, '/elsewhere', 'POST', { Origin: ORIGIN, 'Sec-Fetch-Site': 'same-site', 'Content-Type': 'application/json' }, '{}');
      assert.equal(ok.status, 200);
      assert.equal(ok.headers['access-control-allow-credentials'], 'true', 'routes that do not opt out keep the default');
    } finally {
      await open.close();
    }
  });
});
