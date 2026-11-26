// Routes and the client-side access decision.
//
// IMPORTANT: this decides what the page SHOWS. It is not security. Every protected action is refused by
// the database (RLS and the staff functions) and by the server (packages/auth). A person who edits this
// file still gets no data from the database without the right role and an MFA session.

export const STAFF_ROLES = ['support', 'operations', 'admin'];

const KNOWN = ['', 'search', 'sign-in', 'sign-up', 'recover', 'reset', 'account', 'account/security', 'staff'];

// Parses the URL hash into a route. Query parameters after '?' are returned as params (search only).
// Fragments that carry sign-in tokens are handled separately.
export function parseRoute(hash) {
  const raw = (hash || '').replace(/^#/, '');
  if (raw.includes('access_token=')) return { name: 'auth-callback', params: {} };
  const [pathPart = '', query = ''] = raw.split('?');
  const clean = pathPart.replace(/^\/+/, '').replace(/\/+$/, '');
  if (clean === 'search') {
    return { name: 'search', params: Object.fromEntries(new URLSearchParams(query)) };
  }
  if (!KNOWN.includes(clean)) return { name: 'not-found', params: {} };
  return { name: clean === '' ? 'home' : clean, params: {} };
}

// session: null, or { aal: 'aal1' | 'aal2' | null, role: string | null, hasFactor: boolean }
// Returns { action: 'show' } or { action: 'redirect', to: '#/...' }.
export function accessFor(route, session) {
  switch (route.name) {
    case 'home':
    case 'search':
    case 'sign-in':
    case 'sign-up':
    case 'recover':
    case 'reset':
    case 'auth-callback':
    case 'not-found':
      return { action: 'show' };
    case 'account':
    case 'account/security':
      return session ? { action: 'show' } : { action: 'redirect', to: '#/sign-in' };
    case 'staff': {
      if (!session) return { action: 'redirect', to: '#/sign-in' };
      if (!STAFF_ROLES.includes(session.role)) return { action: 'redirect', to: '#/account' };
      if (session.aal !== 'aal2') {
        return { action: 'redirect', to: session.hasFactor ? '#/sign-in' : '#/account/security' };
      }
      return { action: 'show' };
    }
    default:
      return { action: 'redirect', to: '#/' };
  }
}
