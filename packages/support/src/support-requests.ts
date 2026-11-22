// Support requests: categories, priorities, statuses and the legal status transitions.
//
// Customer replies move a waiting request back to open. Internal notes are never returned to the
// customer. A request for the same booking and category that is still open is returned rather
// than duplicated.

export const CATEGORIES = ['booking', 'cancellation', 'payment', 'ticketing', 'general'] as const;
export type RequestCategory = (typeof CATEGORIES)[number];

export const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export type Priority = (typeof PRIORITIES)[number];

export const REQUEST_STATUSES = ['open', 'assigned', 'awaiting_customer', 'resolved', 'closed'] as const;
export type RequestStatus = (typeof REQUEST_STATUSES)[number];

const TRANSITIONS: Readonly<Record<RequestStatus, readonly RequestStatus[]>> = {
  open: ['assigned', 'awaiting_customer', 'resolved', 'closed'],
  assigned: ['open', 'awaiting_customer', 'resolved', 'closed'],
  awaiting_customer: ['open', 'assigned', 'resolved', 'closed'],
  resolved: ['open', 'closed'],
  closed: [],
};

export function canMoveRequest(from: RequestStatus, to: RequestStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function moveRequest(from: RequestStatus, to: RequestStatus): RequestStatus {
  if (!canMoveRequest(from, to)) throw new RangeError(`Illegal request transition ${from} -> ${to}`);
  return to;
}

// Default priority for a category. Staff may change it with a recorded history entry.
export function defaultPriority(category: RequestCategory): Priority {
  switch (category) {
    case 'payment':
    case 'ticketing':
      return 'high';
    case 'booking':
    case 'cancellation':
      return 'normal';
    case 'general':
      return 'low';
  }
}

export const MESSAGE_MAX = 2000;

export function validateMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new RangeError('Please write a message.');
  if (trimmed.length > MESSAGE_MAX) throw new RangeError(`Please keep messages to ${MESSAGE_MAX} characters.`);
  return trimmed;
}

// Statuses in which a request is still being worked on, used for the duplicate guard.
export const ACTIVE_STATUSES: readonly RequestStatus[] = ['open', 'assigned', 'awaiting_customer'];

export interface Response {
  readonly seq: number;
  readonly at: string;
  readonly authorId: string;
  readonly authorRole: 'customer' | 'staff';
  readonly internal: boolean;
  readonly body: string;
}

export interface StatusChange {
  readonly at: string;
  readonly actorId: string;
  readonly from: RequestStatus | null;
  readonly to: RequestStatus;
  readonly note: string | null;
}

export interface SupportRequest {
  readonly id: string;
  readonly ownerUserId: string;
  readonly category: RequestCategory;
  readonly bookingId: string | null;
  readonly createdAt: string;
  readonly status: RequestStatus;
  readonly priority: Priority;
  readonly assigneeId: string | null;
  readonly responses: readonly Response[];
  readonly history: readonly StatusChange[];
  readonly cancellation: CancellationDetail | null;
}

export interface CancellationDetail {
  readonly acknowledgedFareRules: boolean;
  readonly supplierCheckedAt: string | null;
  readonly execution: 'not_requested' | 'blocked' | 'completed' | 'failed';
  readonly executionReason: string | null;
}
