// Display categories for the dashboards. Every fulfilment status maps to exactly one category.
// The mapping is exhaustive (enforced by the type), so a new status cannot be shown without a
// decision about how to present it.
//
// "Confirmed" is shown only for the fulfilment status 'confirmed', which requires supplier
// tickets AND captured payment (see docs/13). "Tickets issued" is shown for 'ticketed', which
// means the supplier has issued tickets but the payment has not yet been captured.

import type { FulfilmentStatus } from '../../fulfilment/src/status.ts';

export type DisplayCategory =
  | 'pending'
  | 'attention'
  | 'ticketed'
  | 'confirmed'
  | 'failed'
  | 'cancellation_pending'
  | 'cancelled'
  | 'refund_pending'
  | 'refunded';

const CATEGORY: Readonly<Record<FulfilmentStatus, DisplayCategory>> = {
  held: 'pending',
  authorised: 'pending',
  order_pending: 'pending',
  ticketing_pending: 'pending',
  order_unknown: 'attention',
  ticketing_unknown: 'attention',
  partially_fulfilled: 'attention',
  ticketed: 'ticketed',
  confirmed: 'confirmed',
  failed: 'failed',
  expired: 'failed',
  cancellation_pending: 'cancellation_pending',
  cancelled: 'cancelled',
  refund_pending: 'refund_pending',
  refunded: 'refunded',
};

export const CATEGORY_LABEL: Readonly<Record<DisplayCategory, string>> = {
  pending: 'Pending',
  attention: 'Needs checking',
  ticketed: 'Tickets issued',
  confirmed: 'Confirmed',
  failed: 'Not completed',
  cancellation_pending: 'Cancellation in progress',
  cancelled: 'Cancelled',
  refund_pending: 'Refund pending',
  refunded: 'Refunded',
};

export function displayCategory(status: FulfilmentStatus): DisplayCategory {
  return CATEGORY[status];
}

export function categoryLabel(status: FulfilmentStatus): string {
  return CATEGORY_LABEL[CATEGORY[status]];
}

// Statuses in which no supplier write may be retried automatically. A person must check them.
export const NEEDS_CHECKING: readonly FulfilmentStatus[] = ['order_unknown', 'ticketing_unknown', 'partially_fulfilled'];
