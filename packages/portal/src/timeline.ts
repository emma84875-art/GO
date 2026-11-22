// Booking activity timelines.
//
// Times are never invented. An entry whose source did not record a time has at = null and is
// shown as "time not recorded". The fulfilment store currently records an empty string for the
// creation event, which is treated as not recorded.
//
// Staff timelines combine booking history and payment audit entries. Customer timelines show only
// status changes, worded with the customer category labels, and no payment internals.

import type { HistoryEntry } from '../../fulfilment/src/store.ts';
import type { AuditEntry } from '../../payments/src/store.ts';
import { categoryLabel } from './status-category.ts';

export interface TimelineItem {
  readonly at: string | null;
  readonly source: 'booking' | 'payment';
  readonly event: string;
  readonly detail: string;
}

export interface CustomerTimelineItem {
  readonly at: string | null;
  readonly label: string;
}

function timeOrNull(at: string | undefined): string | null {
  if (!at || Number.isNaN(Date.parse(at))) return null;
  return at;
}

function compareItems(a: { at: string | null }, b: { at: string | null }, indexA: number, indexB: number): number {
  // Items without a time come first (they are the earliest record, such as creation).
  if (a.at === null && b.at !== null) return -1;
  if (a.at !== null && b.at === null) return 1;
  if (a.at !== null && b.at !== null) {
    const diff = Date.parse(a.at) - Date.parse(b.at);
    if (diff !== 0) return diff;
  }
  return indexA - indexB;
}

export function buildTimeline(history: readonly HistoryEntry[], paymentAudit: readonly AuditEntry[] = []): TimelineItem[] {
  const combined: TimelineItem[] = [
    ...history.map((h) => ({
      at: timeOrNull(h.at),
      source: 'booking' as const,
      event: h.event,
      detail: h.from === null ? `Created (${h.to ?? 'no status'})` : `${h.from} -> ${h.to ?? 'none'}`,
    })),
    ...paymentAudit.map((a) => ({
      at: timeOrNull(a.at),
      source: 'payment' as const,
      event: a.event,
      detail: a.from === null ? a.detail : `${a.from} -> ${a.to ?? 'none'}: ${a.detail}`,
    })),
  ];
  return combined
    .map((item, index) => ({ item, index }))
    .sort((x, y) => compareItems(x.item, y.item, x.index, y.index))
    .map((x) => x.item);
}

export function customerTimeline(history: readonly HistoryEntry[]): CustomerTimelineItem[] {
  return history
    .filter((h) => h.to !== null)
    .map((h) => ({ at: timeOrNull(h.at), label: categoryLabel(h.to as NonNullable<HistoryEntry['to']>) }))
    .map((item, index) => ({ item, index }))
    .sort((x, y) => compareItems(x.item, y.item, x.index, y.index))
    .map((x) => x.item);
}

// The most recent time a booking changed, or null when no time was recorded.
export function lastChangedAt(history: readonly HistoryEntry[]): string | null {
  let latest: string | null = null;
  for (const entry of history) {
    const at = timeOrNull(entry.at);
    if (at !== null && (latest === null || Date.parse(at) > Date.parse(latest))) latest = at;
  }
  return latest;
}
