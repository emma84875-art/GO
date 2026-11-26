// CORS decisions. Origins are matched exactly. There is no wildcard, and an origin that is not on the
// list is never reflected back. Vary: Origin is always sent so that caches key on the Origin header.
//
// Credentials are allowed only for listed origins. Access-Control-Allow-Credentials is never sent to
// anyone else.

const ALLOWED_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const ALLOWED_REQUEST_HEADERS = 'Authorization, Content-Type';

export type CorsDecision = {
  readonly headers: Record<string, string>;
  readonly allowed: boolean;
  readonly preflight: boolean;
};

// Throws a TypeError for any entry that is not a bare origin (scheme, host and optional port).
// Wildcards, paths, query strings, fragments, credentials and trailing slashes are all refused.
export function validateAllowedOrigins(origins: readonly string[]): void {
  if (!Array.isArray(origins)) throw new TypeError('allowedOrigins must be an array');
  for (const entry of origins) {
    if (typeof entry !== 'string' || entry.includes('*')) {
      throw new TypeError('allowedOrigins must list exact origins with no wildcard');
    }
    let parsed: URL;
    try {
      parsed = new URL(entry);
    } catch {
      throw new TypeError(`allowedOrigins entry is not a valid origin: ${JSON.stringify(entry)}`);
    }
    const isWebScheme = parsed.protocol === 'https:' || parsed.protocol === 'http:';
    if (!isWebScheme || parsed.origin !== entry) {
      throw new TypeError(
        `allowedOrigins entries must be bare origins such as https://app.example.test: ${JSON.stringify(entry)}`,
      );
    }
  }
}

// credentials: false leaves out Access-Control-Allow-Credentials for this request. The default is true,
// which is the behaviour for listed origins on every route. A route that never uses cookies or
// Authorization should set it to false.
export function corsDecision(
  origin: string | undefined,
  method: string,
  config: { allowedOrigins: readonly string[]; credentials?: boolean },
): CorsDecision {
  validateAllowedOrigins(config.allowedOrigins);

  const preflight = method.toUpperCase() === 'OPTIONS';
  const allowed = origin !== undefined && config.allowedOrigins.includes(origin);
  const credentials = config.credentials !== false;

  const headers: Record<string, string> = { Vary: 'Origin' };
  if (allowed) {
    headers['Access-Control-Allow-Origin'] = origin;
    if (credentials) headers['Access-Control-Allow-Credentials'] = 'true';
    if (preflight) {
      headers['Access-Control-Allow-Methods'] = ALLOWED_METHODS;
      headers['Access-Control-Allow-Headers'] = ALLOWED_REQUEST_HEADERS;
    }
  }
  return { headers, allowed, preflight };
}
