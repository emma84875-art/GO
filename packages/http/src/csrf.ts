// CSRF decisions for state-changing requests.
//
// Rules for unsafe methods (anything other than GET, HEAD, OPTIONS):
//   1. Sec-Fetch-Site of cross-site is refused.
//   2. If an Origin header is present it must be on the allowed list.
//   3. If the request carries a cookie session, it must present an allowed Origin. A cookie session
//      without a valid Origin is refused.
//
// Bearer-token-only requests are exempt from rule 3. This exemption is deliberate and is safe only
// because browsers never attach an Authorization header on their own. A cross-site page cannot make
// the browser send a bearer token, and it cannot read one stored by the application. Rule 1 and rule 2
// still apply to bearer-token requests. Any new credential that browsers send automatically (a cookie,
// a client certificate, a Basic auth header) must be added to rule 3 before it is accepted.

const SAFE_METHODS: ReadonlySet<string> = new Set(['GET', 'HEAD', 'OPTIONS']);

export type CsrfDecision = { readonly allowed: boolean; readonly reason: string | null };

export function csrfDecision(input: {
  method: string;
  origin: string | undefined;
  secFetchSite: string | undefined;
  cookieSessionPresent: boolean;
  allowedOrigins: readonly string[];
}): CsrfDecision {
  const method = input.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { allowed: true, reason: null };

  if (input.secFetchSite === 'cross-site') return { allowed: false, reason: 'cross-site request' };

  const originAllowed = input.origin !== undefined && input.allowedOrigins.includes(input.origin);
  if (input.origin !== undefined && !originAllowed) {
    return { allowed: false, reason: 'origin not allowed' };
  }
  if (input.cookieSessionPresent && !originAllowed) {
    return { allowed: false, reason: 'cookie session without an allowed origin' };
  }
  return { allowed: true, reason: null };
}
