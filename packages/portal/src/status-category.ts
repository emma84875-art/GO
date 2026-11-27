// Display categories for the dashboards. Every booking state maps to exactly one category.
// The mapping is exhaustive (enforced by the type), so a new state cannot be shown without a
// decision about how to present it.
//
// "Tickets issued" is shown only from 'verified' onwards, because GO has verified the tickets
// by then (docs/24). A supplier's 'tickets_issued' state is still pending GO's own check.
// "Confirmed" is shown only for 'confirmed', which requires verification and capture (docs/24, section 3).

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
  draft: 'pending',
  quoted: 'pending',
  authorised: 'pending',
  partner_ordered: 'pending',
  ticketing_pending: 'pending',
  tickets_issued: 'pending',
  order_unknown: 'attention',
  ticketing_unknown: 'attention',
  partially_fulfilled: 'attention',
  verification_failed: 'attention',
  review_required: 'attention',
  verified: 'ticketed',
  captured: 'ticketed',
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
export const NEEDS_CHECKING: readonly FulfilmentStatus[] = ['order_unknown', 'ticketing_unknown', 'partially_fulfilled', 'verification_failed', 'review_required'];
