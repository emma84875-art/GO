// Payment authority (Phase 19.2, docs/26). The PostgreSQL payments table (Phase 19.1) is the only authoritative record of
// a payment. This module is the application's only way to read or write it. It holds no payment state of its own.
//
// The payment functions it calls are in supabase/migrations/20261129000000_payment_authority.sql (start, bind, read) and
// in the Phase 19.1 migration (apply_payment_provider_event, which applies a provider result after verification).
// Capture uses request_payment_capture, which is not yet connected to the application (docs/26, section 5).

import { sqlText } from '../../operations/src/postgres-ledger.ts';
import type { SqlExecutor } from '../../operations/src/sql-executor.ts';

export interface PaymentRow {
  readonly id: string;
  readonly bookingId: string;
  readonly provider: string;
  readonly providerReference: string;
  readonly reference: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly status: string;
  readonly capturedMinor: number;
  readonly refundedMinor: number;
  readonly expiresAtUtc: string;
}

export interface StartInput {
  readonly bookingId: string; // uuid of a quoted public.bookings row
  readonly provider: string;
  readonly reference: string; // idempotency reference, also the provider's idempotency key
  readonly amountMinor: number;
  readonly currency: string;
  readonly expiresAtUtc: string;
}

export interface ProviderEventInput {
  readonly provider: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly providerReference: string;
  readonly providerState: 'pending' | 'authorised' | 'captured' | 'failed' | 'released' | 'other' | null;
  readonly amountMinor: number | null;
  readonly currency: string | null;
  readonly occurredAtUtc: string;
  readonly verification: 'webhook_signature' | 'provider_lookup' | 'none';
  readonly payloadSha256: string;
}

export type ProviderEventResult = 'applied' | 'no_change' | 'duplicate' | 'review_required' | 'rejected';

export interface PaymentAuthority {
  start(input: StartInput): Promise<string>;
  bindProviderReference(paymentId: string, providerReference: string): Promise<void>;
  load(paymentId: string): Promise<PaymentRow | null>;
  findByReference(reference: string): Promise<PaymentRow | null>;
  applyProviderEvent(input: ProviderEventInput): Promise<ProviderEventResult>;
}

function toRow(json: string): PaymentRow | null {
  if (json.trim() === '') return null;
  const row = JSON.parse(json) as Record<string, unknown>;
  return {
    id: String(row.id),
    bookingId: String(row.booking_id),
    provider: String(row.provider),
    providerReference: String(row.provider_reference),
    reference: String(row.reference),
    amountMinor: Number(row.amount_minor),
    currency: String(row.currency).trim(),
    status: String(row.status),
    capturedMinor: Number(row.captured_minor),
    refundedMinor: Number(row.refunded_minor),
    expiresAtUtc: String(row.expires_at),
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PostgresPaymentAuthority implements PaymentAuthority {
  readonly #sql: SqlExecutor;

  constructor(sql: SqlExecutor) {
    this.#sql = sql;
  }

  async start(input: StartInput): Promise<string> {
    if (!UUID.test(input.bookingId)) throw new RangeError('booking id must be a uuid');
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) throw new RangeError('amount must be a positive integer');
    const id = (await this.#sql(
      `select public.app_payment_start(${sqlText(input.bookingId)}::uuid, ${sqlText(input.provider)}, ${sqlText(input.reference)}, ` +
      `${input.amountMinor}::bigint, ${sqlText(input.currency)}::char(3), ${sqlText(input.expiresAtUtc)}::timestamptz)::text;`,
    )).trim();
    if (!UUID.test(id)) throw new Error('The database did not return a payment id.');
    return id;
  }

  async bindProviderReference(paymentId: string, providerReference: string): Promise<void> {
    if (!UUID.test(paymentId)) throw new RangeError('payment id must be a uuid');
    await this.#sql(`select public.app_payment_bind_reference(${sqlText(paymentId)}::uuid, ${sqlText(providerReference)});`);
  }

  async load(paymentId: string): Promise<PaymentRow | null> {
    if (!UUID.test(paymentId)) return null;
    return toRow(await this.#sql(`select public.app_payment_load(${sqlText(paymentId)}::uuid)::text;`));
  }

  async findByReference(reference: string): Promise<PaymentRow | null> {
    return toRow(await this.#sql(`select public.app_payment_find_by_reference(${sqlText(reference)})::text;`));
  }

  async applyProviderEvent(input: ProviderEventInput): Promise<ProviderEventResult> {
    const result = (await this.#sql(
      `select public.apply_payment_provider_event(${sqlText(input.provider)}, ${sqlText(input.eventId)}, ${sqlText(input.eventType)}, ` +
      `${sqlText(input.providerReference)}, ${input.providerState === null ? 'null' : sqlText(input.providerState)}, ` +
      `${input.amountMinor === null ? 'null' : `${input.amountMinor}::bigint`}, ` +
      `${input.currency === null ? 'null' : `${sqlText(input.currency)}::char(3)`}, ` +
      `${sqlText(input.occurredAtUtc)}::timestamptz, ${sqlText(input.verification)}, ${sqlText(input.payloadSha256)});`,
    )).trim();
    if (!['applied', 'no_change', 'duplicate', 'review_required', 'rejected'].includes(result)) {
      throw new Error('The database returned an unknown provider event result.');
    }
    return result as ProviderEventResult;
  }
}
