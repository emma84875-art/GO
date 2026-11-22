import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { createAuthClient, aalOf, assertPublicKey, AuthError, PUBLIC_MESSAGES } from '../src/js/auth-client.js';
import { accessFor, parseRoute } from '../src/js/routes.js';
import { passwordIssues, validEmail } from '../src/js/validation.js';
import { checkWebFiles, ROOT } from '../../../scripts/build-web.mjs';
import { PUBLIC_MESSAGES as SERVER_MESSAGES, passwordIssues as serverPasswordIssues } from '../../../packages/auth/src/account-security.ts';

const URL_OK = 'https://gghsvzighgqqamibjywu.supabase.co';
const PUBLISHABLE = 'sb_publishable_test_key_for_unit_tests';

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

function b64url(value) {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

describe('routes', () => {
  test('public pages need no session', () => {
    for (const hash of ['#/', '#/sign-in', '#/sign-up', '#/recover']) {
      assert.deepEqual(accessFor(parseRoute(hash), null), { action: 'show' }, hash);
    }
  });

  test('account pages redirect without a session', () => {
    assert.deepEqual(accessFor(parseRoute('#/account'), null), { action: 'redirect', to: '#/sign-in' });
  });

  test('the staff page refuses customers, even with an MFA session', () => {
    const decision = accessFor(parseRoute('#/staff'), { aal: 'aal2', role: 'customer', hasFactor: true });
    assert.deepEqual(decision, { action: 'redirect', to: '#/account' });
  });

  test('the staff page needs an MFA session for staff', () => {
    assert.deepEqual(accessFor(parseRoute('#/staff'), { aal: 'aal1', role: 'support', hasFactor: true }), {
      action: 'redirect',
      to: '#/sign-in',
    });
    assert.deepEqual(accessFor(parseRoute('#/staff'), { aal: 'aal1', role: 'operations', hasFactor: false }), {
      action: 'redirect',
      to: '#/account/security',
    });
  });

  test('staff with an MFA session see the staff page, operations included', () => {
    assert.deepEqual(accessFor(parseRoute('#/staff'), { aal: 'aal2', role: 'operations', hasFactor: true }), { action: 'show' });
    assert.deepEqual(accessFor(parseRoute('#/staff'), { aal: 'aal2', role: 'admin', hasFactor: true }), { action: 'show' });
  });

  test('a sign-in callback fragment is recognised and unknown paths are not found', () => {
    assert.equal(parseRoute('#access_token=abc&type=recovery').name, 'auth-callback');
    assert.equal(parseRoute('#/nope').name, 'not-found');
  });
});

describe('client-side validation matches the server rules', () => {
  const cases = [
    ['short-pass1', 'ada@example.test'],
    ['correct-hors', 'ada@example.test'],
    ['Ada-Lovelace-2026!', 'ada.lovelace@example.test'],
    ['            ', 'ada@example.test'],
    ['é'.repeat(40) + 'abcdefghijkl', 'ada@example.test'],
    ['a-long-enough-passphrase', 'ada@example.test'],
  ];
  for (const [password, email] of cases) {
    test(`same issues for "${password.slice(0, 12)}"`, () => {
      assert.deepEqual([...passwordIssues(password, email)].sort(), [...serverPasswordIssues(password, email)].sort());
    });
  }

  test('email check accepts a normal address and refuses an empty one', () => {
    assert.equal(validEmail('ada@example.test'), true);
    assert.equal(validEmail('not an email'), false);
    assert.equal(validEmail(''), false);
  });

  test('public messages are the same strings as the server uses', () => {
    assert.deepEqual(PUBLIC_MESSAGES, { ...SERVER_MESSAGES });
  });
});

describe('auth client safety', () => {
  test('refuses a non-HTTPS project URL', () => {
    assert.throws(() => createAuthClient({ url: 'http://example.test', publishableKey: PUBLISHABLE }), TypeError);
  });

  test('refuses a secret or service key in the browser', () => {
    const service = `eyJ${'a'}.${b64url({ role: 'service_role' })}.sig`;
    assert.throws(() => assertPublicKey(service), TypeError);
    assert.throws(() => assertPublicKey('sb_secret_abcdefghijk'), TypeError);
    assert.doesNotThrow(() => assertPublicKey(PUBLISHABLE));
    assert.doesNotThrow(() => assertPublicKey(`eyJ${'a'}.${b64url({ role: 'anon' })}.sig`));
  });

  test('sends only the publishable key, never a bearer for anonymous calls', async () => {
    const seen = [];
    const client = createAuthClient({
      url: URL_OK,
      publishableKey: PUBLISHABLE,
      fetchImpl: async (url, init) => {
        seen.push({ url, init });
        return jsonResponse(200, { access_token: 'a.b.c', refresh_token: 'r', expires_in: 3600 });
      },
    });
    await client.signIn('ada@example.test', 'correct-hors-password');
    assert.equal(seen[0].url, `${URL_OK}/auth/v1/token?grant_type=password`);
    assert.equal(seen[0].init.headers.apikey, PUBLISHABLE);
    assert.equal(seen[0].init.headers.Authorization, undefined);
    assert.equal(seen[0].init.credentials, 'omit');
    assert.equal(seen[0].init.cache, 'no-store');
  });

  test('a failed sign-in shows the fixed message, never the response body', async () => {
    const client = createAuthClient({
      url: URL_OK,
      publishableKey: PUBLISHABLE,
      fetchImpl: async () => jsonResponse(400, { msg: 'Invalid login credentials for ada@example.test' }),
    });
    await assert.rejects(client.signIn('ada@example.test', 'wrong-password-here'), (error) => {
      assert.ok(error instanceof AuthError);
      assert.equal(error.message, PUBLIC_MESSAGES.loginFailed);
      assert.ok(!error.message.includes('ada@example.test'));
      return true;
    });
  });

  test('a network failure becomes the generic message', async () => {
    const client = createAuthClient({
      url: URL_OK,
      publishableKey: PUBLISHABLE,
      fetchImpl: async () => {
        throw new Error('socket hang up with internal detail');
      },
    });
    await assert.rejects(client.getUser(), (error) => error.message === PUBLIC_MESSAGES.generic);
  });

  test('password recovery gives the same answer whatever the fetch outcome', async () => {
    const failing = createAuthClient({
      url: URL_OK,
      publishableKey: PUBLISHABLE,
      fetchImpl: async () => jsonResponse(404, { msg: 'user not found' }),
    });
    const ok = createAuthClient({
      url: URL_OK,
      publishableKey: PUBLISHABLE,
      fetchImpl: async () => jsonResponse(200, {}),
    });
    assert.equal(await failing.requestRecovery('nobody@example.test'), PUBLIC_MESSAGES.recoveryRequested);
    assert.equal(await ok.requestRecovery('ada@example.test'), PUBLIC_MESSAGES.recoveryRequested);
  });

  test('sessions stay in memory and sign-out clears them', async () => {
    const client = createAuthClient({
      url: URL_OK,
      publishableKey: PUBLISHABLE,
      fetchImpl: async (url) => (url.includes('/logout') ? jsonResponse(204, null) : jsonResponse(200, { access_token: 'x.y.z', expires_in: 60 })),
    });
    await client.signIn('ada@example.test', 'correct-hors-password');
    assert.ok(client.session);
    await client.signOut();
    assert.equal(client.session, null);
  });

  test('a recovery fragment adopts the session and reports the type', () => {
    const client = createAuthClient({ url: URL_OK, publishableKey: PUBLISHABLE, fetchImpl: async () => jsonResponse(200, {}) });
    const adopted = client.adoptFromFragment('#access_token=a.b.c&refresh_token=r&type=recovery&expires_in=600');
    assert.deepEqual(adopted, { type: 'recovery' });
    assert.equal(client.session.accessToken, 'a.b.c');
  });

  test('the assurance level is read for display only', () => {
    assert.equal(aalOf(`h.${b64url({ aal: 'aal2' })}.s`), 'aal2');
    assert.equal(aalOf('not-a-token'), null);
  });
});

describe('build checks', () => {
  test('the real web source passes every build check', () => {
    assert.deepEqual(checkWebFiles(join(ROOT, 'apps', 'web', 'src')), []);
  });

  test('a page with an inline script, an event handler and innerHTML is refused', () => {
    const dir = join(ROOT, 'apps', 'web', 'test', '.fixture-bad');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'index.html'), `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'self' 'unsafe-inline'; object-src 'none'"><script>alert(1)</script><button onclick="x()">x</button>`);
      writeFileSync(join(dir, 'app.js'), `document.body.innerHTML = location.hash;`);
      const problems = checkWebFiles(dir).join('\n');
      assert.match(problems, /unsafe inline or eval/);
      assert.match(problems, /inline script is not allowed/);
      assert.match(problems, /inline event handler/);
      assert.match(problems, /raw HTML or code sink/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a service role key in a file is refused', () => {
    const dir = join(ROOT, 'apps', 'web', 'test', '.fixture-secret');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    try {
      writeFileSync(join(dir, 'index.html'), `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; object-src 'none'"><script type="module" src="a.js"></script>`);
      writeFileSync(join(dir, 'a.js'), `export const k = 'sb_secret_0123456789abcdef';`);
      assert.match(checkWebFiles(dir).join('\n'), /secret pattern/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
