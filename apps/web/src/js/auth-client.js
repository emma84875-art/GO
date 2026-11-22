// Client for Supabase Auth over HTTP. No dependencies: the browser's fetch is the only transport.
//
// Rules:
//   - Only the project URL and the PUBLISHABLE key are used here. The service role key must never
//     reach a browser, and the build check refuses any bundle that contains one.
//   - The session lives in memory only. Nothing is written to localStorage or cookies. A page reload
//     signs the person out, which is the safer default until a server-side session is in place.
//   - Errors become fixed public messages (packages/auth/src/account-security.ts). Response bodies are
//     never shown, because they can contain account detail.
//   - Client-side role and MFA checks are for display only. The database and the server decide access.
//
// Endpoint paths follow Supabase Auth's HTTP API as supabase-js calls it. They are not yet verified
// against the live project from this environment; see docs/21-frontend-and-email.md.

export const PUBLIC_MESSAGES = {
  loginFailed: 'Email or password is incorrect.',
  loginThrottled: 'Too many attempts. Wait a few minutes and try again.',
  recoveryRequested: 'If an account exists for that email, we have sent a reset link.',
  verificationSent: 'Check your email for a confirmation link.',
  mfaFailed: 'That code is not valid. Try again.',
  staffMfaRequired: 'Staff accounts need a second sign-in step before they can open this page.',
  generic: 'Something went wrong. Please try again.',
};

export class AuthError extends Error {
  constructor(publicMessage, status) {
    super(publicMessage);
    this.name = 'AuthError';
    this.status = status;
  }
}

// Accepts only a publishable key, or a legacy anon JWT (role "anon"). Anything else is refused, so a
// secret or service key cannot be passed into the browser by mistake.
export function assertPublicKey(key) {
  if (key.startsWith('sb_publishable_')) return;
  let role;
  try {
    const payload = key.split('.')[1];
    role = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/'))).role;
  } catch {
    role = undefined;
  }
  if (role !== 'anon') throw new TypeError('the browser key must be a publishable or anon key');
}

export function createAuthClient({ url, publishableKey, fetchImpl = globalThis.fetch }) {
  if (typeof url !== 'string' || !/^https:\/\/[a-z0-9.-]+\.supabase\.co\/?$/.test(url) && !/^http:\/\/localhost(:\d+)?\/?$/.test(url)) {
    throw new TypeError('url must be the project HTTPS URL');
  }
  if (typeof publishableKey !== 'string' || publishableKey.length < 10) {
    throw new TypeError('publishableKey is required');
  }
  assertPublicKey(publishableKey);
  const base = url.replace(/\/$/, '');
  let session = null; // { accessToken, refreshToken, expiresAt, user }

  async function call(path, { method = 'GET', body, bearer, fallback = PUBLIC_MESSAGES.generic, expectBody = true } = {}) {
    const headers = { apikey: publishableKey, 'Content-Type': 'application/json' };
    const token = bearer ?? session?.accessToken;
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'omit',
        cache: 'no-store',
        referrerPolicy: 'no-referrer',
      });
    } catch {
      throw new AuthError(PUBLIC_MESSAGES.generic, 0);
    }
    if (!response.ok) throw new AuthError(fallback, response.status);
    if (!expectBody) return null;
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  function adoptSession(data) {
    if (!data || typeof data.access_token !== 'string') return null;
    session = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      user: data.user ?? null,
    };
    return session;
  }

  return {
    get session() {
      return session;
    },

    async signUp(email, password) {
      await call('/auth/v1/signup', {
        method: 'POST',
        body: { email, password },
        fallback: PUBLIC_MESSAGES.generic,
      });
      return PUBLIC_MESSAGES.verificationSent;
    },

    async signIn(email, password) {
      const data = await call('/auth/v1/token?grant_type=password', {
        method: 'POST',
        body: { email, password },
        fallback: PUBLIC_MESSAGES.loginFailed,
      });
      return adoptSession(data);
    },

    async refresh() {
      if (!session?.refreshToken) return null;
      try {
        const data = await call('/auth/v1/token?grant_type=refresh_token', {
          method: 'POST',
          body: { refresh_token: session.refreshToken },
          fallback: PUBLIC_MESSAGES.loginFailed,
        });
        return adoptSession(data);
      } catch {
        session = null;
        return null;
      }
    },

    async signOut() {
      try {
        if (session) await call('/auth/v1/logout', { method: 'POST', expectBody: false });
      } finally {
        session = null;
      }
    },

    async requestRecovery(email) {
      // Same message whether or not the account exists.
      try {
        await call('/auth/v1/recover', { method: 'POST', body: { email }, expectBody: false });
      } catch {
        // Deliberately ignored: the response must not reveal the outcome.
      }
      return PUBLIC_MESSAGES.recoveryRequested;
    },

    // Adopts a session from a recovery or confirmation link (implicit flow fragment).
    adoptFromFragment(fragment) {
      const params = new URLSearchParams(fragment.replace(/^#/, ''));
      const accessToken = params.get('access_token');
      if (!accessToken) return null;
      session = {
        accessToken,
        refreshToken: params.get('refresh_token') ?? undefined,
        expiresAt: Date.now() + (Number(params.get('expires_in')) || 3600) * 1000,
        user: null,
      };
      return { type: params.get('type') ?? null };
    },

    async updatePassword(password) {
      await call('/auth/v1/user', { method: 'PUT', body: { password }, fallback: PUBLIC_MESSAGES.generic });
      return 'Your password has been changed.';
    },

    async getUser() {
      const user = await call('/auth/v1/user', { fallback: PUBLIC_MESSAGES.generic });
      if (session) session.user = user;
      return user;
    },

    async getRole() {
      const rows = await call(`/rest/v1/profiles?select=role`, { fallback: PUBLIC_MESSAGES.generic });
      return Array.isArray(rows) && rows.length === 1 ? rows[0].role : null;
    },

    async enrollTotp(friendlyName) {
      return call('/auth/v1/factors', {
        method: 'POST',
        body: { factor_type: 'totp', friendly_name: friendlyName },
        fallback: PUBLIC_MESSAGES.generic,
      });
    },

    async challengeAndVerify(factorId, code) {
      const challenge = await call(`/auth/v1/factors/${encodeURIComponent(factorId)}/challenge`, {
        method: 'POST',
        body: {},
        fallback: PUBLIC_MESSAGES.generic,
      });
      const data = await call(`/auth/v1/factors/${encodeURIComponent(factorId)}/verify`, {
        method: 'POST',
        body: { challenge_id: challenge.id, code },
        fallback: PUBLIC_MESSAGES.mfaFailed,
      });
      return adoptSession(data);
    },
  };
}

// Reads the authenticator assurance level from the access token (display only; not a security check).
export function aalOf(accessToken) {
  try {
    const payload = accessToken.split('.')[1];
    const json = JSON.parse(atob(payload.replace(/-/g, '+').replace(/_/g, '/')));
    return typeof json.aal === 'string' ? json.aal : null;
  } catch {
    return null;
  }
}
