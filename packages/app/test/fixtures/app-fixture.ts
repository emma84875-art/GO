// Fixture values for the application tests. Nothing here calls a live provider. Bookings are created in the test
// database as quoted rows, with a customer account, so the 19.1 rules apply to them as they would in production.
import { randomUUID } from 'node:crypto';
import { FIXTURE_WEBHOOK_HEADER } from '../../../payments/src/adapters/fixture.ts';
import type { Actor } from '../../../auth/src/actor.ts';
import type { SqlExecutor } from '../../../operations/src/sql-executor.ts';
import type { FileBackedFixturePaymentProvider } from './file-provider.ts';

export const NOW = '2026-11-12T09:30:00Z';
export const HOLD_EXPIRY = '2026-11-12T10:00:00Z';
export const SECRET = 'fixture-secret';
export const PAY: Actor = { kind: 'system', service: 'payments' };
export const AMOUNT_MINOR = 150000;
export const CURRENCY = 'NGN';

// Creates a customer account and a quoted booking in the database. Returns the booking's uuid and its owner's uuid.
export async function createQuotedBooking(sql: SqlExecutor): Promise<{ bookingId: string; ownerId: string }> {
  const bookingId = randomUUID();
  const ownerId = randomUUID();
  await sql(
    `insert into auth.users (id) values ('${ownerId}');
     insert into public.profiles (id) values ('${ownerId}') on conflict do nothing;
     insert into public.bookings (id, user_id, display_currency, display_amount_minor) values ('${bookingId}', '${ownerId}', '${CURRENCY}', ${AMOUNT_MINOR});
     update public.bookings set booking_status = 'quoted', quoted_at = now() where id = '${bookingId}';`,
  );
  return { bookingId, ownerId };
}

// The provider's reference for a payment start, computed the same way the fixture does. Used to build a signed webhook.
export function fixtureProviderRef(reference: string): string {
  return `fx_${reference.replace(/[^a-z0-9]+/gi, '_')}`;
}

// A signed webhook body for the given provider event. The provider signs it with the shared secret, as it would in production.
export function signedWebhook(
  provider: FileBackedFixturePaymentProvider,
  event: { readonly id: string; readonly event: string; readonly providerRef: string; readonly state: string; readonly amount?: number },
): { readonly raw: string; readonly signature: string } {
  const raw = JSON.stringify({
    id: event.id, event: event.event, providerRef: event.providerRef, amount: event.amount ?? AMOUNT_MINOR,
    currency: CURRENCY, state: event.state,
  });
  return { raw, signature: provider.sign(raw) };
}

export { FIXTURE_WEBHOOK_HEADER };
