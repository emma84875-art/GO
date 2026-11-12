// Times are stored in UTC. Display always uses the airport's IANA time zone,
// so a Lagos departure and a London arrival are both shown correctly.

export function formatLocalTime(utcIso: string, timeZone: string, locale = 'en-GB'): string {
  const date = new Date(utcIso);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(`Invalid timestamp: ${utcIso}`);
  }
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    timeZoneName: 'short',
  }).format(date);
}

export function durationMinutes(departureUtcIso: string, arrivalUtcIso: string): number {
  const departure = Date.parse(departureUtcIso);
  const arrival = Date.parse(arrivalUtcIso);
  if (Number.isNaN(departure) || Number.isNaN(arrival)) {
    throw new RangeError('Invalid timestamp');
  }
  const minutes = (arrival - departure) / 60_000;
  if (minutes < 0) {
    throw new RangeError('Arrival is before departure');
  }
  return Math.round(minutes);
}
