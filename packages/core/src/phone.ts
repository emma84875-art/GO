// International phone validation. Accepts E.164 (+ then up to 15 digits) after
// removing spaces, dashes, brackets and dots. The country list is a SUBSET used for
// the nationality and dialling-code picker. Extend it to the full ISO list before
// launch.

export interface Country {
  readonly iso: string; // ISO 3166-1 alpha-2
  readonly name: string;
  readonly dialingCode: string; // digits only, no plus
}

export const COUNTRIES: readonly Country[] = [
  { iso: 'NG', name: 'Nigeria', dialingCode: '234' },
  { iso: 'GH', name: 'Ghana', dialingCode: '233' },
  { iso: 'GB', name: 'United Kingdom', dialingCode: '44' },
  { iso: 'US', name: 'United States', dialingCode: '1' },
  { iso: 'AE', name: 'United Arab Emirates', dialingCode: '971' },
  { iso: 'FR', name: 'France', dialingCode: '33' },
  { iso: 'TR', name: 'Türkiye', dialingCode: '90' },
];

export function isKnownCountry(iso: string): boolean {
  return COUNTRIES.some((country) => country.iso === iso);
}

export interface PhoneResult {
  readonly valid: boolean;
  readonly error?: string;
  readonly e164?: string;
}

export function normalisePhone(input: string): string {
  return input.replace(/[\s\-().]/g, '');
}

export function validateInternationalPhone(input: string): PhoneResult {
  const compact = normalisePhone(input);
  if (compact.length === 0) return { valid: false, error: 'Enter a phone number.' };
  if (!compact.startsWith('+')) {
    return { valid: false, error: 'Include the country code, starting with +.' };
  }
  const digits = compact.slice(1);
  if (!/^[1-9]\d*$/.test(digits)) {
    return { valid: false, error: 'Use digits only after the +, and do not start with 0 after the +.' };
  }
  if (digits.length < 8 || digits.length > 15) {
    return { valid: false, error: 'A phone number must have between 8 and 15 digits after the country code.' };
  }
  return { valid: true, e164: `+${digits}` };
}
