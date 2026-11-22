// Security headers sent on every response.
//
// This is an API baseline. GO's API returns JSON only, so the CSP blocks every resource type and
// framing. It is not a policy for serving HTML pages, and it must not be reused for one.
//
// Strict-Transport-Security is sent only when the caller says the service is served over HTTPS.
// Sending HSTS over plain HTTP has no effect and would mislead operators, so it is never added then.

export function securityHeaders(options: { https: boolean }): Record<string, string> {
  if (typeof options.https !== 'boolean') throw new TypeError('https must be a boolean');

  const headers: Record<string, string> = {
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
  if (options.https) {
    headers['Strict-Transport-Security'] = 'max-age=63072000; includeSubDomains';
  }
  return headers;
}
