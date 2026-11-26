// Runs a search end to end and returns one of four explicit states for the UI:
// ok, empty, invalid, or unavailable. Every result carries the supplier label, so
// the UI can say "Development fixture" or "Sandbox" and never present fixture or
// sandbox results as live fares.

import { validateSearch, toSupplierRequest, type FlightSearchInput } from './search.ts';
import {
  NO_EXCLUDED_OFFERS,
  SupplierUnavailableError,
  type ExcludedOffers,
  type FlightSupplier,
  type Offer,
  type SupplierFailureReason,
  type SupplierMode,
  type SupplierSearchResult,
} from './supplier.ts';

export interface SourceLabel {
  readonly name: string;
  readonly mode: SupplierMode;
}

export type SearchOutcome =
  | { readonly status: 'ok'; readonly source: SourceLabel; readonly offers: readonly Offer[]; readonly excluded: ExcludedOffers }
  | { readonly status: 'empty'; readonly source: SourceLabel; readonly excluded: ExcludedOffers }
  | { readonly status: 'invalid'; readonly errors: Readonly<Record<string, string>> }
  | {
      readonly status: 'unavailable';
      readonly source: SourceLabel;
      readonly reason: SupplierFailureReason;
      readonly message: string;
    };

// Only the search method is needed here. The narrow type lets the search service wrap a supplier
// with a deadline and an error boundary without implementing the rest of the interface.
export async function runFlightSearch(
  input: FlightSearchInput,
  today: string,
  supplier: Pick<FlightSupplier, 'name' | 'mode' | 'search' | 'searchDetailed'>,
): Promise<SearchOutcome> {
  const source: SourceLabel = { name: supplier.name, mode: supplier.mode };

  // Validation happens first. An invalid search never reaches a supplier.
  const validation = validateSearch(input, today);
  if (!validation.valid) return { status: 'invalid', errors: validation.errors };

  const request = toSupplierRequest(input, today);
  try {
    // A supplier without searchDetailed returns offers only, so nothing is reported as excluded.
    const result: SupplierSearchResult = supplier.searchDetailed
      ? await supplier.searchDetailed(request)
      : { offers: await supplier.search(request), excluded: NO_EXCLUDED_OFFERS };
    if (result.offers.length === 0) return { status: 'empty', source, excluded: result.excluded };
    return { status: 'ok', source, offers: result.offers, excluded: result.excluded };
  } catch (error) {
    // Only supplier-side failures become UI states. Anything else is a bug and is
    // rethrown so it is not hidden behind a friendly message.
    if (error instanceof SupplierUnavailableError) {
      return { status: 'unavailable', source, reason: error.reason, message: error.message };
    }
    throw error;
  }
}
