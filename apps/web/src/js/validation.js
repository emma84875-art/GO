// Form checks shown before a request is sent. They mirror packages/auth/src/account-security.ts
// (passwordIssues). Parity is tested, so the two cannot drift silently. The server and Supabase still
// enforce the same rules; this only gives the person an early, clear message.

export const PASSWORD_MIN_CHARACTERS = 12;
export const PASSWORD_MAX_BYTES = 72;

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validEmail(value) {
  return typeof value === 'string' && value.length <= 254 && EMAIL.test(value.trim());
}

export function passwordIssues(password, email) {
  if (password.trim().length === 0) return ['blank'];
  const issues = [];
  if ([...password].length < PASSWORD_MIN_CHARACTERS) issues.push('too_short');
  if (new TextEncoder().encode(password).length > PASSWORD_MAX_BYTES) issues.push('too_long');
  const squash = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  const localPart = squash(email.split('@')[0] ?? '');
  if (localPart.length >= 3 && squash(password).includes(localPart)) issues.push('contains_email_name');
  return issues;
}

export const ISSUE_TEXT = {
  blank: 'Enter a password.',
  too_short: `Use at least ${PASSWORD_MIN_CHARACTERS} characters.`,
  too_long: 'Use a password of 72 bytes or fewer.',
  contains_email_name: 'Do not use your email name in the password.',
};
