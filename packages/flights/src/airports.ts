// Airport autocomplete. The dataset below is INCOMPLETE test and demo data: ten airports, not every airport.
// A suggestion from this list does not mean the list is complete, and the page says so. Any three-letter code
// can be typed. Before launch the list must be replaced by a complete, licensed or public IATA-derived dataset.
// No licence has been purchased (see docs/07). Nothing is imported from OurAirports yet.

export interface Airport {
  readonly iata: string;
  readonly name: string;
  readonly city: string;
  readonly country: string; // ISO 3166-1 alpha-2
  readonly timeZone: string; // IANA
  readonly source: 'development-fixture';
}

const FIXTURE: readonly Airport[] = [
  { iata: 'LOS', name: 'Murtala Muhammed International', city: 'Lagos', country: 'NG', timeZone: 'Africa/Lagos', source: 'development-fixture' },
  { iata: 'ABV', name: 'Nnamdi Azikiwe International', city: 'Abuja', country: 'NG', timeZone: 'Africa/Lagos', source: 'development-fixture' },
  { iata: 'PHC', name: 'Port Harcourt International', city: 'Port Harcourt', country: 'NG', timeZone: 'Africa/Lagos', source: 'development-fixture' },
  { iata: 'KAN', name: 'Mallam Aminu Kano International', city: 'Kano', country: 'NG', timeZone: 'Africa/Lagos', source: 'development-fixture' },
  { iata: 'ACC', name: 'Kotoka International', city: 'Accra', country: 'GH', timeZone: 'Africa/Accra', source: 'development-fixture' },
  { iata: 'LHR', name: 'London Heathrow', city: 'London', country: 'GB', timeZone: 'Europe/London', source: 'development-fixture' },
  { iata: 'DXB', name: 'Dubai International', city: 'Dubai', country: 'AE', timeZone: 'Asia/Dubai', source: 'development-fixture' },
  { iata: 'JFK', name: 'John F. Kennedy International', city: 'New York', country: 'US', timeZone: 'America/New_York', source: 'development-fixture' },
  { iata: 'CDG', name: 'Charles de Gaulle', city: 'Paris', country: 'FR', timeZone: 'Europe/Paris', source: 'development-fixture' },
  { iata: 'IST', name: 'Istanbul Airport', city: 'Istanbul', country: 'TR', timeZone: 'Europe/Istanbul', source: 'development-fixture' },
];

export function findAirport(iata: string): Airport | undefined {
  return FIXTURE.find((airport) => airport.iata === iata);
}

// Ranks matches: exact code first, then code prefix, city prefix, city or name contains.
export function searchAirports(query: string, limit = 8): readonly Airport[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [];

  const scored: { airport: Airport; score: number }[] = [];
  for (const airport of FIXTURE) {
    const code = airport.iata.toLowerCase();
    const city = airport.city.toLowerCase();
    const name = airport.name.toLowerCase();
    let score = 0;
    if (code === q) score = 100;
    else if (code.startsWith(q)) score = 80;
    else if (city.startsWith(q)) score = 60;
    else if (city.includes(q)) score = 40;
    else if (name.includes(q)) score = 20;
    if (score > 0) scored.push({ airport, score });
  }

  return scored
    .sort((a, b) => b.score - a.score || a.airport.iata.localeCompare(b.airport.iata))
    .slice(0, limit)
    .map((entry) => entry.airport);
}
