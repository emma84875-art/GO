// GO web app: views, forms and the hash router. Plain DOM, no framework, no innerHTML.
// Every piece of text is set with textContent, so nothing from the server or the person is parsed as markup.

import config from '../config.js';
import { createAuthClient, aalOf, AuthError, PUBLIC_MESSAGES } from './auth-client.js';
import { el } from './dom.js';
import { viewHome, viewSearch } from './flight-views.js';
import { accessFor, parseRoute } from './routes.js';
import { ISSUE_TEXT, passwordIssues, validEmail } from './validation.js';

const app = document.getElementById('app');
const nav = document.getElementById('nav');
const configured = Boolean(config.SUPABASE_URL && config.SUPABASE_PUBLISHABLE_KEY);
const client = configured
  ? createAuthClient({ url: config.SUPABASE_URL, publishableKey: config.SUPABASE_PUBLISHABLE_KEY })
  : null;

let profile = null; // { role, aal, hasFactor, email } for the signed-in person, display only
let recoveryMode = false;

function field(label, input) {
  return el('label', { class: 'field' }, [el('span', { text: label }), input]);
}

function input(type, name, extra = {}) {
  return el('input', { type, name, required: 'required', autocomplete: extra.autocomplete ?? 'off', ...extra });
}

function message(text, kind = 'info') {
  return el('p', { class: `notice ${kind}`, role: 'status', text });
}

function errorText(error) {
  return error instanceof AuthError ? error.message : PUBLIC_MESSAGES.generic;
}

function formOf(onSubmit, children, submitLabel) {
  return el('form', { novalidate: 'novalidate', onsubmit: onSubmit }, [
    ...children,
    el('button', { type: 'submit', class: 'primary', text: submitLabel }),
  ]);
}

function setNotice(slot, text, kind) {
  slot.replaceChildren(message(text, kind));
}

async function refreshProfile() {
  if (!client?.session) {
    profile = null;
    return;
  }
  const user = await client.getUser().catch(() => null);
  const role = await client.getRole().catch(() => null);
  profile = {
    role,
    aal: aalOf(client.session.accessToken),
    hasFactor: Array.isArray(user?.factors) && user.factors.some((f) => f.status === 'verified'),
    email: user?.email ?? '',
  };
}

function renderNav() {
  const brand = el('a', { href: '#/', class: 'brand', 'aria-label': 'GO home' }, [
    el('img', { src: 'img/go-wordmark-purple.svg', alt: 'GO', class: 'logo logo-light', width: '96', height: '48' }),
    el('img', { src: 'img/go-wordmark-white.svg', alt: '', class: 'logo logo-dark', width: '96', height: '48' }),
  ]);
  const links = [brand, el('a', { href: '#/search', text: 'Search flights' })];
  if (profile) {
    links.push(el('a', { href: '#/account', text: 'Account' }));
    links.push(el('a', { href: '#/account/security', text: 'Security' }));
    if (profile.role && ['support', 'operations', 'admin'].includes(profile.role)) {
      links.push(el('a', { href: '#/staff', text: 'Staff' }));
    }
    links.push(el('button', { type: 'button', class: 'link', text: 'Sign out', onclick: onSignOut }));
  } else {
    links.push(el('a', { href: '#/sign-in', text: 'Sign in' }));
    links.push(el('a', { href: '#/sign-up', text: 'Create account' }));
  }
  nav.replaceChildren(...links);
}

function viewSignUp() {
  const slot = el('div');
  const email = input('email', 'email', { autocomplete: 'email' });
  const password = input('password', 'password', { autocomplete: 'new-password', minlength: '12' });
  const confirm = input('password', 'confirm', { autocomplete: 'new-password' });
  const form = formOf(
    async (event) => {
      event.preventDefault();
      if (!client) return setNotice(slot, 'Sign-up is not configured yet.', 'error');
      if (!validEmail(email.value)) return setNotice(slot, 'Enter a valid email address.', 'error');
      const issues = passwordIssues(password.value, email.value);
      if (issues.length) return setNotice(slot, ISSUE_TEXT[issues[0]], 'error');
      if (password.value !== confirm.value) return setNotice(slot, 'The passwords do not match.', 'error');
      try {
        setNotice(slot, await client.signUp(email.value.trim(), password.value), 'info');
      } catch (error) {
        setNotice(slot, errorText(error), 'error');
      }
    },
    [field('Email', email), field('Password (12 characters or more)', password), field('Confirm password', confirm)],
    'Create account',
  );
  return el('section', {}, [el('h1', { text: 'Create your account' }), form, slot]);
}

function viewSignIn() {
  const slot = el('div');
  const email = input('email', 'email', { autocomplete: 'email' });
  const password = input('password', 'password', { autocomplete: 'current-password' });
  const form = formOf(
    async (event) => {
      event.preventDefault();
      if (!client) return setNotice(slot, 'Sign-in is not configured yet.', 'error');
      if (!validEmail(email.value) || password.value.length === 0) {
        return setNotice(slot, PUBLIC_MESSAGES.loginFailed, 'error');
      }
      try {
        await client.signIn(email.value.trim(), password.value);
        await refreshProfile();
        location.hash = profile?.hasFactor && profile.aal !== 'aal2' ? '#/sign-in' : '#/account';
        if (profile?.hasFactor && profile.aal !== 'aal2') {
          render();
        }
      } catch (error) {
        setNotice(slot, errorText(error), 'error');
      }
    },
    [field('Email', email), field('Password', password)],
    'Sign in',
  );
  const links = el('p', { class: 'links' }, [
    el('a', { href: '#/recover', text: 'Forgot your password?' }),
  ]);
  const children = [el('h1', { text: 'Sign in' }), form, links, slot];
  if (client?.session && profile?.hasFactor && profile.aal !== 'aal2') {
    children.unshift(viewMfaChallenge(slot));
  }
  return el('section', {}, children);
}

// Second step for accounts with a verified factor. Needed for staff; optional for customers.
function viewMfaChallenge(slot) {
  const code = el('input', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6', required: 'required' });
  const form = formOf(
    async (event) => {
      event.preventDefault();
      try {
        const user = await client.getUser();
        const factorId = user?.factors?.find((f) => f.status === 'verified')?.id;
        if (!factorId) return setNotice(slot, PUBLIC_MESSAGES.mfaFailed, 'error');
        await client.challengeAndVerify(factorId, code.value.trim());
        await refreshProfile();
        location.hash = '#/account';
      } catch (error) {
        setNotice(slot, errorText(error), 'error');
      }
    },
    [field('Code from your authenticator app', code)],
    'Verify',
  );
  return el('div', { class: 'card' }, [el('h2', { text: 'Second step' }), form]);
}

function viewRecover() {
  const slot = el('div');
  const email = input('email', 'email', { autocomplete: 'email' });
  const form = formOf(
    async (event) => {
      event.preventDefault();
      if (!client) return setNotice(slot, 'Recovery is not configured yet.', 'error');
      if (!validEmail(email.value)) return setNotice(slot, 'Enter a valid email address.', 'error');
      setNotice(slot, await client.requestRecovery(email.value.trim()), 'info');
    },
    [field('Email', email)],
    'Send reset link',
  );
  return el('section', {}, [el('h1', { text: 'Reset your password' }), form, slot]);
}

function viewReset() {
  if (!recoveryMode) {
    return el('section', {}, [
      el('h1', { text: 'Reset link needed' }),
      el('p', {}, ['Open the reset link from your email, or ', el('a', { href: '#/recover', text: 'request a new one' }), '.']),
    ]);
  }
  const slot = el('div');
  const password = input('password', 'password', { autocomplete: 'new-password', minlength: '12' });
  const confirm = input('password', 'confirm', { autocomplete: 'new-password' });
  const form = formOf(
    async (event) => {
      event.preventDefault();
      const issues = passwordIssues(password.value, profile?.email ?? '');
      if (issues.length) return setNotice(slot, ISSUE_TEXT[issues[0]], 'error');
      if (password.value !== confirm.value) return setNotice(slot, 'The passwords do not match.', 'error');
      try {
        setNotice(slot, await client.updatePassword(password.value), 'info');
        recoveryMode = false;
      } catch (error) {
        setNotice(slot, errorText(error), 'error');
      }
    },
    [field('New password (12 characters or more)', password), field('Confirm new password', confirm)],
    'Set new password',
  );
  return el('section', {}, [el('h1', { text: 'Choose a new password' }), form, slot]);
}

function viewAccount() {
  return el('section', {}, [
    el('h1', { text: 'Your account' }),
    el('p', { text: `Signed in as ${profile?.email || 'your account'}.` }),
    el('p', {}, [el('a', { href: '#/account/security', text: 'Set up or review two-step sign-in' })]),
  ]);
}

function viewSecurity() {
  const slot = el('div');
  const secret = el('code', { class: 'secret' });
  const qr = el('img', { alt: 'QR code for your authenticator app', class: 'qr', width: '200', height: '200' });
  const code = el('input', { type: 'text', name: 'code', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9]{6}', maxlength: '6', required: 'required' });
  const enrolBtn = el('button', {
    type: 'button',
    class: 'primary',
    text: 'Start two-step sign-in setup',
    onclick: async () => {
      try {
        const data = await client.enrollTotp('GO authenticator');
        factorState.id = data.id;
        secret.textContent = data.totp?.secret ?? '';
        if (data.totp?.qr_code) {
          qr.src = `data:image/svg+xml;base64,${btoa(data.totp.qr_code)}`;
        }
        setNotice(slot, 'Scan the code with your authenticator app, then enter the 6-digit code below.', 'info');
      } catch (error) {
        setNotice(slot, errorText(error), 'error');
      }
    },
  });
  const factorState = { id: null };
  const verify = formOf(
    async (event) => {
      event.preventDefault();
      if (!factorState.id) return setNotice(slot, 'Start the setup first.', 'error');
      try {
        await client.challengeAndVerify(factorState.id, code.value.trim());
        await refreshProfile();
        setNotice(slot, 'Two-step sign-in is active on this account.', 'info');
      } catch (error) {
        setNotice(slot, errorText(error), 'error');
      }
    },
    [field('6-digit code', code)],
    'Confirm code',
  );
  return el('section', {}, [
    el('h1', { text: 'Two-step sign-in' }),
    el('p', { text: 'Staff accounts must use two-step sign-in. It is optional for customers.' }),
    enrolBtn,
    qr,
    el('p', {}, ['Secret (for manual entry): ', secret]),
    verify,
    slot,
  ]);
}

function viewStaff() {
  return el('section', {}, [
    el('h1', { text: 'Staff area' }),
    el('p', { text: `Role: ${profile?.role ?? 'unknown'}. Your access is checked again by the database on every request.` }),
    el('p', { text: 'Operational screens are not built yet. This page confirms that the route is protected.' }),
  ]);
}

function viewNotFound() {
  return el('section', {}, [el('h1', { text: 'Page not found' }), el('p', {}, [el('a', { href: '#/', text: 'Go to the start page' })])]);
}

async function onSignOut() {
  try {
    await client?.signOut();
  } finally {
    profile = null;
    location.hash = '#/';
  }
}

const VIEWS = {
  home: () => viewHome(),
  search: (params) => viewSearch(params),
  'sign-in': viewSignIn,
  'sign-up': viewSignUp,
  recover: viewRecover,
  reset: viewReset,
  account: viewAccount,
  'account/security': viewSecurity,
  staff: viewStaff,
  'not-found': viewNotFound,
};

function render() {
  const route = parseRoute(location.hash);
  const session = client?.session ? { aal: profile?.aal ?? null, role: profile?.role ?? null, hasFactor: Boolean(profile?.hasFactor) } : null;
  const decision = accessFor(route, session);
  if (decision.action === 'redirect') {
    location.hash = decision.to;
    return;
  }
  renderNav();
  const view = VIEWS[route.name] ?? viewNotFound;
  app.replaceChildren(
    ...(configured ? [] : [message('This build is not connected to a Supabase project yet. Set the project URL and publishable key in config.js.', 'error')]),
    view(route.params),
  );
  app.focus();
}

async function start() {
  if (client && location.hash.includes('access_token=')) {
    const adopted = client.adoptFromFragment(location.hash);
    if (adopted?.type === 'recovery') recoveryMode = true;
    history.replaceState(null, '', `${location.pathname}#/${recoveryMode ? 'reset' : 'account'}`);
  }
  // Sessions are kept in memory only, so a reload signs the person out. Nothing is restored here.
  await refreshProfile();
  render();
}

window.addEventListener('hashchange', render);
start();
