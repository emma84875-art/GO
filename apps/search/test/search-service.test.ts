import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ConfigError, loadConfig, parseAllowedOrigins, type SearchConfig } from '../src/config.ts';
import { createSearchServer, type SearchSupplier } from '../src/app.ts';
import { createServer } from '../../../packages/http/src/server.ts';
import { SupplierUnavailableError, type Offer, type SearchRequest } from '../../../packages/flights/src/supplier.ts';
import type { HttpTransport } from '../../../packages/flights/src/adapters/duffel.ts';

const ORIGIN = 'https://go-web.example';
const NOW = new Date('2026-11-24T10:00:00Z');
const FIXED_NOW = () => NOW;
const TOKEN = 'duffel_test_not_a_real_token_123';

function testConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return {
    port: 0,
    allowedOrigins: [ORIGIN],
    https: true,
    maxBodyBytes: 16_384,
    rateLimit: { limit: 1000, windowSeconds: 60 },
    supplierTimeoutMs: 2000,
    supplier: { kind: 'none' },
    ...overrides,
  };
}

type Reply = { status: number; headers: Record<string, string | string[] | undefined>; text: string };

// Uses node:http directly so that Origin and Sec-Fetch-Site can be set the way a browser sends them.
function call(base: string, path: string, options: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, base), { method: options.method ?? 'POST', headers: options.headers ?? {} }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function jsonCall(base: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Reply> {
  return call(base, path, {
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'Sec-Fetch-Site': 'same-site', ...headers },
    body: JSON.stringify(body),
  });
}

async function start(config: SearchConfig, options: Parameters<typeof createSearchServer>[1] = {}, server?: Server) {
  const instance = server ?? createSearchServer(config, { now: FIXED_NOW, log: () => undefined, ...options });
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', () => resolve()));
  const { port } = instance.address() as AddressInfo;
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((resolve) => instance.close(() => resolve())) };
}

const oneWay = {
  tripType: 'one_way',
  origin: 'LOS',
  destination: 'LHR',
  departureDate: '2026-12-01',
  passengers: { adults: 1 },
  cabin: 'economy',
  displayCurrency: 'USD',
};

const multiCity = {
  tripType: 'multi_city',
  legs: [
    { origin: 'LOS', destination: 'LHR', departureDate: '2026-12-01' },
    { origin: 'LHR', destination: 'DXB', departureDate: '2026-12-05' },
    { origin: 'DXB', destination: 'LOS', departureDate: '2026-12-09' },
  ],
  passengers: { adults: 2, children: 1 },
  cabin: 'business',
  displayCurrency: 'USD',
};

// Synthetic Duffel-shaped payload for tests. It is not a real fare and is never shown as one.
function segment(origin: string, destination: string, departing: string, arriving: string) {
  return {
    departing_at: departing,
    arriving_at: arriving,
    origin: { iata_code: origin, time_zone: 'Africa/Lagos' },
    destination: { iata_code: destination, time_zone: 'Europe/London' },
    marketing_carrier: { iata_code: 'TT' },
    marketing_carrier_flight_number: '100',
  };
}
function syntheticPayload(slices: unknown[]) {
  return { data: { offers: [{ id: 'off_synthetic', total_amount: '1000.00', total_currency: 'USD', expires_at: '2026-11-30T12:00:00Z', slices }] } };
}
const syntheticSliceOne = { segments: [segment('LOS', 'LHR', '2026-12-01T08:00:00Z', '2026-12-01T15:00:00Z')] };
const syntheticSliceTwo = { segments: [segment('LHR', 'DXB', '2026-12-05T08:00:00Z', '2026-12-05T18:00:00Z')] };
const syntheticSliceThree = { segments: [segment('DXB', 'LOS', '2026-12-09T08:00:00Z', '2026-12-09T16:00:00Z')] };

function transportReturning(payload: unknown): { transport: HttpTransport; calls: () => number } {
  let count = 0;
  return {
    calls: () => count,
    transport: async () => {
      count += 1;
      return { status: 200, json: async () => payload };
    },
  };
}

function duffelConfig(overrides: Partial<SearchConfig> = {}): SearchConfig {
  return testConfig({ supplier: { kind: 'duffel', accessToken: TOKEN }, ...overrides });
}

describe('configuration', () => {
  test('the allowed origin list is required', () => {
    assert.throws(() => loadConfig({}), (error: unknown) => error instanceof ConfigError && /SEARCH_ALLOWED_ORIGINS is required/.test(error.message));
  });

  test('wildcards, paths, queries and trailing slashes are refused', () => {
    for (const bad of ['*', 'https://*.example', 'https://go-web.example/', 'https://go-web.example/app', 'https://go-web.example?x=1']) {
      assert.throws(() => parseAllowedOrigins(bad, false), ConfigError, bad);
    }
  });

  test('plain http is refused except for localhost when explicitly allowed', () => {
    assert.throws(() => parseAllowedOrigins('http://go-web.example', false), ConfigError);
    assert.throws(() => parseAllowedOrigins('http://localhost:5173', false), ConfigError);
    assert.deepEqual([...parseAllowedOrigins('http://localhost:5173', true)], ['http://localhost:5173']);
  });

  test('error messages name the variable and never echo the value', () => {
    try {
      parseAllowedOrigins('https://go-web.example/path?token=SECRET_VALUE_XYZ', false);
      assert.fail('expected a refusal');
    } catch (error) {
      assert.ok(error instanceof ConfigError);
      assert.equal(error.message.includes('SECRET_VALUE_XYZ'), false);
      assert.equal(error.message.includes('token='), false);
    }
  });

  test('defaults are safe, and the supplier is none unless duffel is chosen', () => {
    const config = loadConfig({ SEARCH_ALLOWED_ORIGINS: ORIGIN });
    assert.equal(config.port, 3001);
    assert.equal(config.https, true);
    assert.equal(config.maxBodyBytes, 16_384);
    assert.equal(config.supplierTimeoutMs, 15_000);
    assert.deepEqual(config.rateLimit, { limit: 30, windowSeconds: 60 });
    assert.deepEqual(config.supplier, { kind: 'none' });
  });

  test('a blank Duffel token is treated as missing, and a real one is trimmed', () => {
    const blank = loadConfig({ SEARCH_ALLOWED_ORIGINS: ORIGIN, SEARCH_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: '   ' });
    assert.deepEqual(blank.supplier, { kind: 'duffel', accessToken: undefined });
    const set = loadConfig({ SEARCH_ALLOWED_ORIGINS: ORIGIN, SEARCH_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: `  ${TOKEN}  ` });
    assert.deepEqual(set.supplier, { kind: 'duffel', accessToken: TOKEN });
  });

  test('unknown suppliers and out-of-range numbers are refused, naming only the variable', () => {
    assert.throws(() => loadConfig({ SEARCH_ALLOWED_ORIGINS: ORIGIN, SEARCH_SUPPLIER: 'sabre' }), /SEARCH_SUPPLIER/);
    assert.throws(() => loadConfig({ SEARCH_ALLOWED_ORIGINS: ORIGIN, SEARCH_SUPPLIER_TIMEOUT_MS: '999999' }), /SEARCH_SUPPLIER_TIMEOUT_MS must be between/);
    assert.throws(() => loadConfig({ SEARCH_ALLOWED_ORIGINS: ORIGIN, SEARCH_RATE_LIMIT: 'many' }), /SEARCH_RATE_LIMIT must be a whole number/);
  });
});

describe('HTTP surface', () => {
  let running: Awaited<ReturnType<typeof start>>;
  before(async () => {
    running = await start(testConfig());
  });
  after(async () => {
    await running.close();
  });

  test('health answers 200 without supplier or configuration detail', async () => {
    const reply = await call(running.base, '/health', { method: 'GET' });
    assert.equal(reply.status, 200);
    assert.deepEqual(JSON.parse(reply.text), { status: 'ok' });
  });

  test('every response carries the security headers and no-store caching', async () => {
    const reply = await call(running.base, '/health', { method: 'GET' });
    const csp = String(reply.headers['content-security-policy']);
    assert.ok(csp.startsWith("default-src 'none'"), csp);
    assert.ok(csp.includes("frame-ancestors 'none'"), csp);
    assert.equal(reply.headers['x-frame-options'], 'DENY');
    assert.equal(reply.headers['cache-control'], 'no-store');
    assert.equal(reply.headers['strict-transport-security'] !== undefined, true, 'HSTS on when https is configured');
  });

  test('unknown paths are 404 and the wrong method is 405', async () => {
    assert.equal((await call(running.base, '/nope', { method: 'GET' })).status, 404);
    assert.equal((await call(running.base, '/api/flights/search', { method: 'GET' })).status, 405);
  });

  test('CORS answers an allowed origin with that origin, never a wildcard', async () => {
    const preflight = await call(running.base, '/api/flights/search', {
      method: 'OPTIONS',
      headers: { Origin: ORIGIN, 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], ORIGIN);
    assert.notEqual(preflight.headers['access-control-allow-origin'], '*');
  });

  test('CORS does not grant an unlisted origin', async () => {
    const preflight = await call(running.base, '/api/flights/search', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' },
    });
    assert.equal(preflight.headers['access-control-allow-origin'], undefined);
  });

  test('a POST from an unlisted origin is refused', async () => {
    const reply = await jsonCall(running.base, '/api/flights/search', oneWay, { Origin: 'https://evil.example' });
    assert.equal(reply.status, 403);
  });

  test('a cross-site POST from the listed static site is allowed on the search route (opt-in)', async () => {
    const supplier: SearchSupplier = { name: 'fake', mode: 'sandbox', search: async () => [] };
    const open = await start(testConfig(), { supplier });
    try {
      const reply = await jsonCall(open.base, '/api/flights/search', oneWay, { 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(reply.status, 200);
      assert.equal(JSON.parse(reply.text).status, 'empty');
    } finally {
      await open.close();
    }
  });

  test('the cross-site opt-in does not extend to other unsafe routes', async () => {
    const plain = await start(testConfig(), {}, createServer(
      {
        allowedOrigins: [ORIGIN],
        https: true,
        maxBodyBytes: 16_384,
        rateLimit: { limit: 1000, windowSeconds: 60 },
        sessionCookieName: 'go_search_session',
      },
      [{ method: 'POST', path: '/elsewhere', auth: 'public', handler: () => ({ status: 200, body: {} }) }],
    ));
    try {
      const reply = await jsonCall(plain.base, '/elsewhere', {}, { 'Sec-Fetch-Site': 'cross-site' });
      assert.equal(reply.status, 403);
    } finally {
      await plain.close();
    }
  });

  test('a body that is too large is refused with 413, and bad JSON with 400', async () => {
    const small = await start(testConfig({ maxBodyBytes: 2048 }));
    try {
      const big = await call(small.base, '/api/flights/search', {
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: JSON.stringify({ ...oneWay, filler: 'x'.repeat(4000) }),
      });
      assert.equal(big.status, 413);
      const bad = await call(small.base, '/api/flights/search', {
        headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
        body: '{not json',
      });
      assert.equal(bad.status, 400);
      assert.equal(JSON.parse(bad.text).error, 'invalid_json');
    } finally {
      await small.close();
    }
  });

  test('requests over the rate limit get 429 with Retry-After', async () => {
    const limited = await start(testConfig({ rateLimit: { limit: 2, windowSeconds: 60 } }));
    try {
      // The search route is counted. GET /health is exempt (see the Phase 18.4 tests below).
      const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
      await call(limited.base, '/api/flights/search', { headers, body: '{}' });
      await call(limited.base, '/api/flights/search', { headers, body: '{}' });
      const third = await call(limited.base, '/api/flights/search', { headers, body: '{}' });
      assert.equal(third.status, 429);
      assert.ok(Number(third.headers['retry-after']) >= 1);
    } finally {
      await limited.close();
    }
  });
});

describe('search contract', () => {
  test('a one-way search returns the supplier offers with the source label', async () => {
    const offer = { id: 'off_1' } as unknown as Offer;
    const supplier: SearchSupplier = { name: 'fake', mode: 'sandbox', search: async () => [offer] };
    const running = await start(testConfig(), { supplier });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay, { Origin: ORIGIN });
      assert.equal(reply.status, 200);
      const body = JSON.parse(reply.text);
      assert.equal(body.status, 'ok');
      assert.deepEqual(body.source, { name: 'fake', mode: 'sandbox' });
      assert.equal(body.offers.length, 1);
    } finally {
      await running.close();
    }
  });

  test('a multi-city search reaches the supplier with every leg, in order', async () => {
    let seen: SearchRequest | undefined;
    const supplier: SearchSupplier = {
      name: 'fake',
      mode: 'sandbox',
      search: async (request) => {
        seen = request;
        return [];
      },
    };
    const running = await start(testConfig(), { supplier });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', multiCity);
      assert.equal(reply.status, 200);
      assert.equal(JSON.parse(reply.text).status, 'empty');
      assert.ok(seen?.legs !== undefined);
      assert.deepEqual(seen?.legs?.map((leg) => [leg.origin, leg.destination, leg.departureDate]), [
        ['LOS', 'LHR', '2026-12-01'],
        ['LHR', 'DXB', '2026-12-05'],
        ['DXB', 'LOS', '2026-12-09'],
      ]);
      assert.equal(seen?.passengers, 3);
      assert.equal(seen?.cabin, 'business');
    } finally {
      await running.close();
    }
  });

  test('a multi-city search through the Duffel adapter returns every journey', async () => {
    const { transport } = transportReturning(syntheticPayload([syntheticSliceOne, syntheticSliceTwo, syntheticSliceThree]));
    const running = await start(duffelConfig(), { transport });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', multiCity);
      assert.equal(reply.status, 200);
      const body = JSON.parse(reply.text);
      assert.equal(body.status, 'ok');
      assert.equal(body.offers[0].journeys.length, 3);
    } finally {
      await running.close();
    }
  });

  test('an invalid search gets 422 with field messages, and no input is echoed', async () => {
    const running = await start(testConfig());
    try {
      // Shape errors are reported first and stop the request, so the unknown field comes back alone.
      const shape = await jsonCall(running.base, '/api/flights/search', {
        ...oneWay,
        passengerNames: ['ATTACKER_NAME_<script>'],
      });
      assert.equal(shape.status, 422);
      const shapeBody = JSON.parse(shape.text);
      assert.equal(shapeBody.status, 'invalid');
      assert.ok('unknownField' in shapeBody.errors);
      assert.equal(shape.text.includes('ATTACKER_NAME'), false);

      // Meaning errors come from validateSearch once the shape is right.
      const meaning = await jsonCall(running.base, '/api/flights/search', { ...oneWay, destination: 'LOS' });
      assert.equal(meaning.status, 422);
      assert.equal(JSON.parse(meaning.text).errors.destination, 'Destination must be different from departure.');
    } finally {
      await running.close();
    }
  });

  test('a multi-city search with too few legs is refused with the leg message', async () => {
    const running = await start(testConfig());
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', { ...multiCity, legs: [multiCity.legs[0]] });
      assert.equal(reply.status, 422);
      assert.equal(JSON.parse(reply.text).errors.legs, 'Add at least two journeys for a multi-city search.');
    } finally {
      await running.close();
    }
  });

  test('no supplier configured gives 503 not_configured and never touches the network', async () => {
    const counter = transportReturning({});
    const running = await start(testConfig({ supplier: { kind: 'duffel', accessToken: undefined } }), { transport: counter.transport });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay);
      assert.equal(reply.status, 503);
      const body = JSON.parse(reply.text);
      assert.equal(body.status, 'unavailable');
      assert.equal(body.reason, 'not_configured');
      assert.equal(body.message, 'Flight search is not connected yet.');
      assert.equal(counter.calls(), 0);
    } finally {
      await running.close();
    }
  });

  test('the service with supplier "none" answers not_configured', async () => {
    const running = await start(testConfig({ supplier: { kind: 'none' } }));
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay);
      assert.equal(reply.status, 503);
      assert.equal(JSON.parse(reply.text).reason, 'not_configured');
    } finally {
      await running.close();
    }
  });

  test('an empty result is an explicit empty state, not an error', async () => {
    const supplier: SearchSupplier = { name: 'fake', mode: 'sandbox', search: async () => [] };
    const running = await start(testConfig(), { supplier });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay);
      assert.equal(reply.status, 200);
      assert.equal(JSON.parse(reply.text).status, 'empty');
    } finally {
      await running.close();
    }
  });

  test('a provider HTTP error gives 502, and the provider text never reaches the browser', async () => {
    const transport: HttpTransport = async () => ({ status: 500, json: async () => ({ secret: 'PROVIDER_SECRET_BODY' }) });
    const running = await start(duffelConfig(), { transport });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay);
      assert.equal(reply.status, 502);
      assert.equal(JSON.parse(reply.text).reason, 'provider_error');
      assert.equal(reply.text.includes('PROVIDER_SECRET_BODY'), false);
    } finally {
      await running.close();
    }
  });

  test('a transport exception with a stack or secret in its message gives 502 with fixed text', async () => {
    const transport: HttpTransport = async () => {
      throw new Error(`boom ${TOKEN}`);
    };
    const running = await start(duffelConfig(), { transport });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay);
      assert.equal(reply.status, 502);
      assert.equal(reply.text.includes(TOKEN), false);
      assert.equal(reply.text.includes('boom'), false);
      assert.equal(JSON.parse(reply.text).message, 'The flight provider is unavailable right now. Try again later.');
    } finally {
      await running.close();
    }
  });

  test('a provider that never answers gets 504 at the deadline, even if it ignores the abort signal', async () => {
    const transport: HttpTransport = () => new Promise(() => undefined);
    const running = await start(duffelConfig({ supplierTimeoutMs: 100 }), { transport });
    try {
      const started = Date.now();
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay);
      assert.equal(reply.status, 504);
      assert.equal(JSON.parse(reply.text).reason, 'timeout');
      assert.ok(Date.now() - started < 2000, 'answered at the deadline, not after a long wait');
    } finally {
      await running.close();
    }
  });

  test('an unexpected error from a supplier becomes a provider_error, not a 500 with details', async () => {
    const supplier: SearchSupplier = {
      name: 'fake',
      mode: 'sandbox',
      search: async () => {
        throw new TypeError('SECRET_INTERNAL_DETAIL');
      },
    };
    const running = await start(testConfig(), { supplier });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay);
      assert.equal(reply.status, 502);
      assert.equal(reply.text.includes('SECRET_INTERNAL_DETAIL'), false);
    } finally {
      await running.close();
    }
  });

  test('a supplier error message is replaced by the fixed text for its reason', async () => {
    const supplier: SearchSupplier = {
      name: 'fake',
      mode: 'sandbox',
      search: async () => {
        throw new SupplierUnavailableError('fx_unavailable', 'RATE_SOURCE_SECRET');
      },
    };
    const running = await start(testConfig(), { supplier });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay);
      assert.equal(reply.status, 503);
      assert.equal(reply.text.includes('RATE_SOURCE_SECRET'), false);
    } finally {
      await running.close();
    }
  });

  test('a response with the wrong number of journeys counts the offer as malformed and does not fail the search', async () => {
    const { transport } = transportReturning(syntheticPayload([syntheticSliceOne, syntheticSliceTwo]));
    const running = await start(duffelConfig(), { transport });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', multiCity);
      assert.equal(reply.status, 200);
      const body = JSON.parse(reply.text);
      assert.equal(body.status, 'empty');
      assert.equal(body.excluded.malformed, 1);
    } finally {
      await running.close();
    }
  });
});

describe('connection limits', () => {
  test('header, request and keep-alive timeouts are set shorter than Node defaults', () => {
    const server = createSearchServer(testConfig(), { log: () => undefined });
    assert.equal(server.headersTimeout, 10_000);
    assert.equal(server.requestTimeout, 30_000);
    assert.equal(server.keepAliveTimeout, 5_000);
    server.close();
  });
});

describe('logging', () => {
  test('each request logs a closed set of fields, and no token, name or result detail', async () => {
    const lines: string[] = [];
    const transport: HttpTransport = async () => {
      throw new Error(`leak ${TOKEN}`);
    };
    const running = await start(duffelConfig(), { transport, log: (line) => lines.push(line) });
    try {
      await call(running.base, '/health', { method: 'GET' });
      await jsonCall(running.base, '/api/flights/search', { ...oneWay, passengers: { adults: 1 }, origin: 'LOS' });
      assert.ok(lines.length >= 2);
      const allowed = new Set(['time', 'service', 'event', 'route', 'status', 'outcome', 'reason', 'durationMs']);
      for (const line of lines) {
        assert.equal(line.includes(TOKEN), false);
        const fields = Object.keys(JSON.parse(line));
        for (const field of fields) assert.ok(allowed.has(field), `unexpected log field ${field}`);
      }
    } finally {
      await running.close();
    }
  });

  test('a configured token never appears in a response', async () => {
    const transport: HttpTransport = async () => ({ status: 401, json: async () => ({}) });
    const running = await start(duffelConfig(), { transport });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay);
      assert.equal(reply.text.includes(TOKEN), false);
      const health = await call(running.base, '/health', { method: 'GET' });
      assert.equal(health.text.includes(TOKEN), false);
    } finally {
      await running.close();
    }
  });
});

describe('Phase 18.4 corrections: token rule, health check and forwarded addresses', () => {
  test('a live Duffel token is refused at configuration, and the message never contains the value', () => {
    const live = 'duffel_live_not_a_real_token_456';
    assert.throws(
      () => loadConfig({ SEARCH_ALLOWED_ORIGINS: ORIGIN, SEARCH_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: live }),
      (error: unknown) => error instanceof ConfigError && error.message.includes('DUFFEL_ACCESS_TOKEN') && !error.message.includes(live),
    );
  });

  test('an unrecognised Duffel token is refused the same way', () => {
    const odd = 'sk_not_a_duffel_token_789';
    assert.throws(
      () => loadConfig({ SEARCH_ALLOWED_ORIGINS: ORIGIN, SEARCH_SUPPLIER: 'duffel', DUFFEL_ACCESS_TOKEN: odd }),
      (error: unknown) => error instanceof ConfigError && !error.message.includes(odd),
    );
  });

  test('GET /health is not rate limited, while the search route still is', async () => {
    const limited = await start(testConfig({ rateLimit: { limit: 1, windowSeconds: 60 } }));
    try {
      for (let i = 0; i < 3; i += 1) {
        assert.equal((await call(limited.base, '/health', { method: 'GET' })).status, 200);
      }
      const headers = { 'Content-Type': 'application/json', Origin: ORIGIN };
      assert.equal((await call(limited.base, '/api/flights/search', { headers, body: '{}' })).status, 422);
      assert.equal((await call(limited.base, '/api/flights/search', { headers, body: '{}' })).status, 429);
    } finally {
      await limited.close();
    }
  });

  test('a forwarded-address header does not give a client a new rate-limit bucket', async () => {
    const limited = await start(testConfig({ rateLimit: { limit: 2, windowSeconds: 60 } }));
    try {
      const statuses: number[] = [];
      for (const ip of ['198.51.100.1', '198.51.100.2', '198.51.100.3']) {
        const reply = await call(limited.base, '/api/flights/search', {
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'X-Forwarded-For': ip },
          body: '{}',
        });
        statuses.push(reply.status);
      }
      assert.deepEqual(statuses, [422, 422, 429]);
    } finally {
      await limited.close();
    }
  });
});

describe('Phase 18.5: untrusted input cannot inject currency or passenger data', () => {
  test('an FX rate or a price field in the request is refused, and the supplier is never called', async () => {
    let calls = 0;
    const supplier: SearchSupplier = { name: 'fake', mode: 'sandbox', search: async () => { calls += 1; return []; } };
    const running = await start(testConfig(), { supplier });
    try {
      for (const field of ['fxRate', 'fxSnapshot', 'displayPrice', 'supplierPrice']) {
        const reply = await call(running.base, '/api/flights/search', {
          headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
          body: JSON.stringify({ ...oneWay, [field]: { rateScaled: '1' } }),
        });
        assert.equal(reply.status, 422, field);
      }
      assert.equal(calls, 0);
    } finally {
      await running.close();
    }
  });

  test('adults, children and infants reach the supplier request with their own counts', async () => {
    const seen: SearchRequest[] = [];
    const supplier: SearchSupplier = { name: 'fake', mode: 'sandbox', search: async (request) => { seen.push(request); return []; } };
    const running = await start(testConfig(), { supplier });
    try {
      const body = JSON.stringify({ ...oneWay, passengers: { adults: 2, children: 1, infants: 1 } });
      const reply = await call(running.base, '/api/flights/search', { headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body });
      assert.equal(reply.status, 200);
      assert.equal(seen.length, 1);
      assert.equal(seen[0].adults, 2);
      assert.equal(seen[0].children, 1);
      assert.equal(seen[0].infants, 1);
      assert.equal(seen[0].passengers, 3);
    } finally {
      await running.close();
    }
  });
});

describe('Phase 18.6: exclusions reach the customer response', () => {
  test('when every supplier offer is excluded, the answer is an honest empty result with the counts', async () => {
    const excluded = { invalidCurrency: 2, currencies: ['AED', 'JPY'], invalidPrice: 1, malformed: 0 };
    const supplier: SearchSupplier = {
      name: 'fake',
      mode: 'sandbox',
      search: async () => [],
      searchDetailed: async () => ({ offers: [], excluded }),
    };
    const running = await start(testConfig(), { supplier });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay, { Origin: ORIGIN });
      const body = JSON.parse(reply.text);
      assert.equal(reply.status, 200);
      assert.equal(body.status, 'empty');
      assert.deepEqual(body.offers, []);
      assert.deepEqual(body.excluded, excluded);
    } finally {
      await running.close();
    }
  });

  test('a successful answer also reports what was left out', async () => {
    const supplier: SearchSupplier = {
      name: 'fake',
      mode: 'sandbox',
      search: async () => [],
      searchDetailed: async () => ({ offers: [{ id: 'off_1' } as unknown as Offer], excluded: { invalidCurrency: 1, currencies: ['JPY'], invalidPrice: 0, malformed: 0 } }),
    };
    const running = await start(testConfig(), { supplier });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay, { Origin: ORIGIN });
      const body = JSON.parse(reply.text);
      assert.equal(body.status, 'ok');
      assert.equal(body.excluded.invalidCurrency, 1);
    } finally {
      await running.close();
    }
  });

  test('a supplier without searchDetailed reports no exclusions, and the page still gets its offers', async () => {
    const supplier: SearchSupplier = { name: 'fake', mode: 'sandbox', search: async () => [{ id: 'off_2' } as unknown as Offer] };
    const running = await start(testConfig(), { supplier });
    try {
      const reply = await jsonCall(running.base, '/api/flights/search', oneWay, { Origin: ORIGIN });
      const body = JSON.parse(reply.text);
      assert.equal(body.status, 'ok');
      assert.deepEqual(body.excluded, { invalidCurrency: 0, currencies: [], invalidPrice: 0, malformed: 0 });
    } finally {
      await running.close();
    }
  });
});

