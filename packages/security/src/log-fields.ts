// Builds log-safe objects. Only allowlisted keys survive. Values that look like
// personal data are redacted even under an allowed key. Nested objects, arrays and
// functions are dropped rather than walked, so nothing hidden inside them can leak.

export type LogValue = string | number | boolean | null;

const EMAIL_PATTERN = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// 5 to 20 letters or digits containing at least one digit and at least one letter.
const DOCUMENT_TOKEN_PATTERN = /\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{5,20}\b/g;
const DOCUMENT_KEY_PATTERN = /doc|passport|number|ticket/i;
const LONG_DIGITS_PATTERN = /\d{9,}/g;
const LONG_DIGITS_CHECK = /\d{9,}/;

export function safeLogFields(
  input: Record<string, unknown>,
  allowed: readonly string[],
): Record<string, LogValue> {
  const output: Record<string, LogValue> = {};
  for (const key of allowed) {
    if (!Object.hasOwn(input, key)) continue;
    const value = input[key];
    const safe = safeValue(key, value);
    if (safe !== undefined) {
      output[key] = safe;
    }
  }
  return output;
}

function safeValue(key: string, value: unknown): LogValue | undefined {
  switch (typeof value) {
    case 'string':
      return redactString(key, value);
    case 'number': {
      if (!Number.isFinite(value)) return null;
      // Numbers stay numbers unless their digits look like a long identifier.
      return LONG_DIGITS_CHECK.test(String(value)) ? '[number]' : value;
    }
    case 'boolean':
      return value;
    default:
      if (value === null) return null;
      // Objects, arrays, functions, symbols, bigints and undefined are dropped.
      return undefined;
  }
}

function redactString(key: string, value: string): string {
  let out = value.replace(EMAIL_PATTERN, '[email]');
  if (DOCUMENT_KEY_PATTERN.test(key)) {
    out = out.replace(DOCUMENT_TOKEN_PATTERN, '[document]');
  }
  out = out.replace(LONG_DIGITS_PATTERN, '[number]');
  return out;
}
