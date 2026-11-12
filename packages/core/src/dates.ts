// Calendar date helpers shared by the booking modules. Dates are YYYY-MM-DD and are
// checked as real calendar dates, never by string shape alone.

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isRealCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}
