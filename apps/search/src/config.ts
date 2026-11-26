// Configuration for the search service, read from environment variables.
//
// Every value is validated at start-up. Error messages name the variable but never its value, so a
// mistyped secret cannot end up in logs. The Duffel token is returned to the caller only so the
// supplier can use it. It is never logged, returned or placed in an error message.
//
// Variables (see docs/23-search-service.md for the Render steps):
//   SEARCH_ALLOWED_ORIGINS      required. Comma-separated exact origins of the static site,
//                               e.g. https://go-web.example. No wildcard, path or trailing slash.
//   SEARCH_ALLOW_LOCAL_ORIGINS  optional. "true" also allows http://localhost and http://127.0.0.1
//                               origins. For local development only; never set on Render.
//   SEARCH_HTTPS                optional. "false" disables the HSTS header for local development.
//   SEARCH_SUPPLIER             optional. "none" (default) or "duffel".
//   DUFFEL_ACCESS_TOKEN         required when SEARCH_SUPPLIER is "duffel". Must start with "duffel_test_".
//                               Any other value is refused at start-up.
//   SEARCH_SUPPLIER_TIMEOUT_MS  optional. Default 15000. Range 1000 to 30000.
//   SEARCH_RATE_LIMIT           optional. Requests per window per address. Default 30. Range 1 to 1000.
//   SEARCH_RATE_WINDOW_SECONDS  optional. Default 60. Range 1 to 3600.
//   SEARCH_MAX_BODY_BYTES       optional. Default 16384. Range 1024 to 65536.
//   PORT                        optional. Render sets it. Default 3001 for local runs.

import { DUFFEL_TEST_TOKEN_PREFIX } from '../../../packages/flights/src/adapters/duffel.ts';

export type SupplierChoice =
  | { readonly kind: 'none' }
  | { readonly kind: 'duffel'; readonly accessToken: string | undefined };

export interface SearchConfig {
  readonly port: number;
  readonly allowedOrigins: readonly string[];
  readonly https: boolean;
  readonly maxBodyBytes: number;
  readonly rateLimit: { readonly limit: number; readonly windowSeconds: number };
  readonly supplierTimeoutMs: number;
  readonly supplier: SupplierChoice;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

type Env = Readonly<Record<string, string | undefined>>;

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1']);

function readInteger(env: Env, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new ConfigError(`${name} must be a whole number`);
  const value = Number(raw.trim());
  if (value < min || value > max) throw new ConfigError(`${name} must be between ${min} and ${max}`);
  return value;
}

export function parseAllowedOrigins(raw: string | undefined, allowLocal: boolean): readonly string[] {
  if (raw === undefined || raw.trim() === '') {
    throw new ConfigError('SEARCH_ALLOWED_ORIGINS is required (the static site origin)');
  }
  const origins: string[] = [];
  for (const part of raw.split(',')) {
    const candidate = part.trim();
    if (candidate === '*' || candidate.includes('*')) {
      throw new ConfigError('SEARCH_ALLOWED_ORIGINS must list exact origins, never a wildcard');
    }
    let url: URL;
    try {
      url = new URL(candidate);
    } catch {
      throw new ConfigError('SEARCH_ALLOWED_ORIGINS contains a value that is not a URL');
    }
    // An exact origin has no path, query, fragment or trailing slash.
    if (url.origin !== candidate) {
      throw new ConfigError('SEARCH_ALLOWED_ORIGINS entries must be origins only (scheme, host and port)');
    }
    const localOk = allowLocal && url.protocol === 'http:' && LOCAL_HOSTS.has(url.hostname);
    if (url.protocol !== 'https:' && !localOk) {
      throw new ConfigError('SEARCH_ALLOWED_ORIGINS entries must use https');
    }
    origins.push(candidate);
  }
  return Object.freeze(origins);
}

// Only Duffel test tokens are accepted (see DUFFEL_TEST_TOKEN_PREFIX in the adapter), so a live credential
// cannot reach the service through configuration.
function readSupplier(env: Env): SupplierChoice {
  const raw = (env.SEARCH_SUPPLIER ?? 'none').trim();
  if (raw === 'none') return { kind: 'none' };
  if (raw === 'duffel') {
    const token = env.DUFFEL_ACCESS_TOKEN?.trim();
    if (token === undefined || token === '') return { kind: 'duffel', accessToken: undefined };
    // The message names the variable only. The value is never shown, whatever it contains.
    if (!token.startsWith(DUFFEL_TEST_TOKEN_PREFIX)) {
      throw new ConfigError('DUFFEL_ACCESS_TOKEN must be a Duffel test token. Live tokens are refused in this service.');
    }
    return { kind: 'duffel', accessToken: token };
  }
  throw new ConfigError('SEARCH_SUPPLIER must be "none" or "duffel"');
}

export function loadConfig(env: Env): SearchConfig {
  const allowLocal = env.SEARCH_ALLOW_LOCAL_ORIGINS === 'true';
  return {
    port: readInteger(env, 'PORT', 3001, 1, 65535),
    allowedOrigins: parseAllowedOrigins(env.SEARCH_ALLOWED_ORIGINS, allowLocal),
    https: env.SEARCH_HTTPS !== 'false',
    maxBodyBytes: readInteger(env, 'SEARCH_MAX_BODY_BYTES', 16_384, 1024, 65_536),
    rateLimit: {
      limit: readInteger(env, 'SEARCH_RATE_LIMIT', 30, 1, 1000),
      windowSeconds: readInteger(env, 'SEARCH_RATE_WINDOW_SECONDS', 60, 1, 3600),
    },
    supplierTimeoutMs: readInteger(env, 'SEARCH_SUPPLIER_TIMEOUT_MS', 15_000, 1000, 30_000),
    supplier: readSupplier(env),
  };
}
