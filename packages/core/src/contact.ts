// Contact details for the booking. Only what is needed to send the booking
// confirmation and to reach the traveller about changes is collected: an email and a
// phone number. Nothing else.

import { validateInternationalPhone } from './phone.ts';

export interface ContactDetails {
  readonly email: string;
  readonly phone: string;
}

export interface ContactValidation {
  readonly valid: boolean;
  readonly errors: Readonly<Record<string, string>>;
}

// Practical check, not RFC 5322. Delivery is confirmed by the email provider later.
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function validateContact(contact: ContactDetails): ContactValidation {
  const errors: Record<string, string> = {};
  const email = contact.email.trim();
  if (email.length === 0) {
    errors.email = 'Enter an email address.';
  } else if (email.length > 254 || !EMAIL_PATTERN.test(email)) {
    errors.email = 'Enter a valid email address.';
  }
  const phone = validateInternationalPhone(contact.phone);
  if (!phone.valid) errors.phone = phone.error ?? 'Enter a valid phone number.';
  return { valid: Object.keys(errors).length === 0, errors };
}
