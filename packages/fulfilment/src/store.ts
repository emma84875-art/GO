// Fulfilment store (in-memory for now). Holds the booking record, the idempotency log of
// supplier operations, and an append-only status history. Persistence to the database must
// keep the same guarantees. Passenger data is in this store, so it must never leave through
// a log or a view without the role checks in privacy.ts.

import type { HoldPassenger, Offer, TicketDocument } from '../../flights/src/supplier.ts';
import type { FulfilmentStatus } from './status.ts';
import { canMove, move } from './status.ts';

export interface FulfilmentRecord {
  readonly bookingId: string;
  readonly status: FulfilmentStatus;
  readonly intentId: string;
  readonly offer: Offer;
  readonly passengers: readonly HoldPassenger[];
  readonly totalMinor: number;
  readonly currency: string;
  readonly holdExpiresAtUtc: string;
  readonly orderId: string | null;
  readonly bookingReference: string | null;
  readonly documents: readonly TicketDocument[];
  readonly lockedReason: string | null;
  readonly blockedReason: string | null; // why capture or a step was not allowed
}

export interface OperationRecord {
  readonly key: string;
  readonly state: 'sent' | 'done';
  readonly orderId: string | null;
}

export interface HistoryEntry {
  readonly at: string;
  readonly bookingId: string;
  readonly from: FulfilmentStatus | null;
  readonly to: FulfilmentStatus | null;
  readonly event: string;
}

export class FulfilmentStore {
  private readonly records = new Map<string, FulfilmentRecord>();
  private readonly operations = new Map<string, OperationRecord>();
  private readonly history: HistoryEntry[] = [];

  create(record: FulfilmentRecord): void {
    if (this.records.has(record.bookingId)) throw new RangeError('Booking already exists');
    this.records.set(record.bookingId, record);
    this.history.push({ at: '', bookingId: record.bookingId, from: null, to: record.status, event: 'created' });
  }

  get(bookingId: string): FulfilmentRecord | undefined {
    return this.records.get(bookingId);
  }

  operation(key: string): OperationRecord | undefined {
    return this.operations.get(key);
  }

  // Writes the operation BEFORE the supplier call ('sent') and again after its result ('done').
  // A 'sent' record without a result means the outcome is unknown and must not be re-sent.
  recordOperation(record: OperationRecord): void {
    this.operations.set(record.key, record);
  }

  // Changes status through the legal move table and appends history. Never mutates in place.
  transition(bookingId: string, to: FulfilmentStatus, event: string, at: string, patch: Partial<FulfilmentRecord> = {}): FulfilmentRecord {
    const current = this.records.get(bookingId);
    if (!current) throw new RangeError('Unknown booking');
    move(current.status, to);
    const next: FulfilmentRecord = { ...current, ...patch, status: to };
    this.records.set(bookingId, next);
    this.history.push({ at, bookingId, from: current.status, to, event });
    return next;
  }

  // Patches fields without changing status (for example, recording documents while polling).
  patch(bookingId: string, patch: Partial<FulfilmentRecord>): FulfilmentRecord {
    const current = this.records.get(bookingId);
    if (!current) throw new RangeError('Unknown booking');
    const next = { ...current, ...patch };
    this.records.set(bookingId, next);
    return next;
  }

  canMove(from: FulfilmentStatus, to: FulfilmentStatus): boolean {
    return canMove(from, to);
  }

  // Read-only copy of the history. It cannot be edited through this class.
  historyFor(bookingId: string): readonly HistoryEntry[] {
    return this.history.filter((entry) => entry.bookingId === bookingId);
  }
}
