// Application composition root (Phase 19.2, docs/26). It connects the pieces the payment path needs and holds no state
// of its own:
//   - the PostgreSQL operation ledger, constructed here and given to every flow that sends an external request;
//   - the PostgreSQL payment authority, which is the only record of a payment (Phase 19.1 payments table);
//   - the payment provider adapter, supplied by the caller.
//
// Nothing here is authoritative in memory. A restart loses nothing, because every decision is read from the database.
//
// Not connected here, and not implemented (docs/26, section 5): booking creation and its profile link, supplier orders,
// capture, release and refund. Booking state and the fulfilment flow stay in their in-memory modules and are not
// authoritative. They must not be wired here until the booking integration in docs/26 is complete.

import type { Actor } from '../../auth/src/actor.ts';
import { PostgresOperationLedger } from '../../operations/src/postgres-ledger.ts';
import type { SqlExecutor } from '../../operations/src/sql-executor.ts';
import { PostgresPaymentAuthority, type PaymentRow } from '../../payments/src/authority.ts';
import {
  handleWebhookDurable,
  reconcilePaymentStart,
  startPaymentDurable,
  type ReconcileOutcome,
  type StartOutcome,
  type StartRequest,
  type WebhookOutcome,
} from '../../payments/src/durable-flow.ts';
import type { PaymentProvider } from '../../payments/src/provider.ts';

export interface ApplicationOptions {
  readonly sql: SqlExecutor;
  readonly provider: PaymentProvider;
  readonly productionEnabled?: boolean; // owner gate; false until approval
  readonly paymentStartLeaseSeconds?: number; // ledger lease for a start; the default is set by the payment flow
}

// Functions the payment path needs. Start-up refuses to run if any is missing, so the application never runs against
// an unmigrated database.
const REQUIRED_FUNCTIONS = [
  'public.app_payment_start(uuid, text, text, bigint, bpchar, timestamptz)',
  'public.app_payment_bind_reference(uuid, text)',
  'public.app_payment_load(uuid)',
  'public.app_payment_find_by_reference(text)',
  'public.apply_payment_provider_event(text, text, text, text, text, bigint, bpchar, timestamptz, text, text)',
  'public.reconcile_operation(uuid, text, text, text, text, text, text)',
  'public.begin_operation(text, text, uuid, text, text, text, text, text, integer)',
] as const;

export class Application {
  readonly ledger: PostgresOperationLedger;
  readonly authority: PostgresPaymentAuthority;
  readonly #options: ApplicationOptions;

  constructor(options: ApplicationOptions) {
    this.#options = options;
    this.ledger = new PostgresOperationLedger(options.sql);
    this.authority = new PostgresPaymentAuthority(options.sql);
  }

  startPayment(actor: Actor, request: StartRequest, nowUtc: string): Promise<StartOutcome> {
    return startPaymentDurable(
      {
        authority: this.authority,
        ledger: this.ledger,
        provider: this.#options.provider,
        gate: { productionEnabled: this.#options.productionEnabled === true },
        leaseSeconds: this.#options.paymentStartLeaseSeconds,
      },
      actor,
      request,
      nowUtc,
    );
  }

  reconcilePaymentStart(bookingId: string, reconcilerLabel: string): Promise<ReconcileOutcome> {
    return reconcilePaymentStart(
      { authority: this.authority, ledger: this.ledger, provider: this.#options.provider },
      bookingId,
      reconcilerLabel,
    );
  }

  handleWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>, nowUtc: string): Promise<WebhookOutcome> {
    return handleWebhookDurable({ authority: this.authority, provider: this.#options.provider }, rawBody, headers, nowUtc);
  }

  payment(paymentId: string): Promise<PaymentRow | null> {
    return this.authority.load(paymentId);
  }
}

// Connects to the database, checks that the migrations are in place, and returns the application. Fails closed.
export async function startApplication(options: ApplicationOptions): Promise<Application> {
  const ping = (await options.sql('select 1;')).trim();
  if (ping !== '1') throw new Error('The database did not answer the start-up check.');
  const missing = (await options.sql(
    `select string_agg(f, ', ') from unnest(array[${REQUIRED_FUNCTIONS.map((f) => `'${f}'`).join(', ')}]) as f ` +
    `where to_regprocedure(f) is null;`,
  )).trim();
  if (missing !== '') throw new Error(`The database is missing required functions: ${missing}`);
  return new Application(options);
}
