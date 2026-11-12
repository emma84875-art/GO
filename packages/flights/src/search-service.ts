// Runs a search end to end and returns one of four explicit states for the UI:
// ok, empty, invalid, or unavailable. Every result carries the supplier label, so
// the UI can say "Development fixture" or "Sandbox" and never present fixture or
// sandbox results as live fares.

import { validateSearch, toSupplierRequest, type FlightSearchInput } from './search.ts';
import { SupplierUnavailableError, type FlightSupplier, type Offer, type SupplierFailureReason, type SupplierMode } from './supplier.ts';

export interface SourceLabel {
  readonly name: string;
  readonly mode: SupplierMode;
}

export type SearchOutcome =
  | { readonly status: 'ok'; readonly source: SourceLabel; readonly offers: readonly Offer[] }
  | { readonly status: 'empty'; readonly source: SourceLabel }
  | { readonly status: 'invalid'; readonly errors: Readonly<Record<string, string>> }
  | {
      readonly status: 'unavailable';
      readonly source: SourceLabel;
      readonly reason: SupplierFailureReason;
      readonly message: string;
    };

export async function runFlightSearch(
  input: FlightSearchInput,
  today: string,
  supplier: FlightSupplier,
): Promise<SearchOutcome> {
  const source: SourceLabel = { name: supplier.name, mode: supplier.mode };

  // Validation happens first. An invalid search never reaches a supplier.
  const validation = validateSearch(input, today);
  if (!validation.valid) return { status: 'invalid', errors: validation.errors };

  const request = toSupplierRequest(input, today);
  try {
    const offers = await supplier.search(request);
    if (offers.length === 0) return { status: 'empty', source };
    return { status: 'ok', source, offers };
  } catch (error) {
    // Only supplier-side failures become UI states. Anything else is a bug and is
    // rethrown so it is not hidden behind a friendly message.
    if (error instanceof SupplierUnavailableError) {
      return { status: 'unavailable', source, reason: error.reason, message: error.message };
    }
    throw error;
  }
}
