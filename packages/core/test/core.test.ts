import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { money, addMoney, sumMoney, formatMoney } from '../src/money.ts';
import {
  canTransitionReservation,
  canTransitionTicket,
  transitionTicket,
  customerStatusLabel,
} from '../src/booking-status.ts';
import { formatLocalTime, durationMinutes } from '../src/time.ts';

describe('money', () => {
  test('stores integer minor units with a currency', () => {
    assert.deepEqual(money(12345, 'NGN'), { amountMinor: 12345, currency: 'NGN' });
  });

  test('rejects floats and unsafe integers', () => {
    assert.throws(() => money(10.5, 'USD'), TypeError);
    assert.throws(() => money(Number.MAX_SAFE_INTEGER + 2, 'USD'), TypeError);
  });

  test('rejects unsupported currencies', () => {
    assert.throws(() => money(100, 'XYZ' as never), TypeError);
  });

  test('refuses to add different currencies without an explicit conversion', () => {
    assert.throws(() => addMoney(money(100, 'USD'), money(100, 'NGN')), TypeError);
  });

  test('sums values in the same currency', () => {
    assert.deepEqual(sumMoney([money(100, 'GBP'), money(250, 'GBP')], 'GBP'), money(350, 'GBP'));
  });

  test('formats using the currency minor-unit exponent', () => {
    const formatted = formatMoney(money(123456, 'NGN'), 'en-NG');
    assert.match(formatted, /1,234\.56/);
  });
});

describe('reservation status', () => {
  test('allows the forward path only', () => {
    assert.equal(canTransitionReservation('draft', 'quoted'), true);
    assert.equal(canTransitionReservation('payment_confirmed', 'reservation_pending'), true);
    assert.equal(canTransitionReservation('draft', 'reservation_confirmed'), false);
  });

  test('confirmed and failed reservations are terminal', () => {
    assert.equal(canTransitionReservation('reservation_confirmed', 'draft'), false);
    assert.equal(canTransitionReservation('reservation_failed', 'reservation_pending'), false);
  });
});

describe('ticket status', () => {
  test('cannot start ticketing before the reservation is confirmed', () => {
    assert.throws(
      () => transitionTicket('reservation_pending', 'not_issued', 'ticketing_pending'),
      /Cannot start ticketing/,
    );
  });

  test('can move to ticketed only from ticketing_pending', () => {
    assert.equal(canTransitionTicket('not_issued', 'ticketed'), false);
    assert.equal(canTransitionTicket('ticketing_pending', 'ticketed'), true);
  });

  test('ticketing failure is terminal and is not silently retried', () => {
    assert.equal(canTransitionTicket('ticketing_failed', 'ticketing_pending'), false);
  });
});

describe('customer status label', () => {
  test('shows Ticketed only when the ticket status is ticketed', () => {
    assert.equal(customerStatusLabel('reservation_confirmed', 'ticketed'), 'Ticketed');
    for (const reservation of ['reservation_pending', 'reservation_confirmed', 'payment_confirmed'] as const) {
      for (const ticket of ['not_issued', 'ticketing_pending', 'ticketing_failed'] as const) {
        assert.notEqual(customerStatusLabel(reservation, ticket), 'Ticketed');
      }
    }
  });

  test('a reservation without tickets is never described as confirmed ticket', () => {
    const label = customerStatusLabel('reservation_pending', 'not_issued');
    assert.match(label, /not yet ticketed/);
  });
});

describe('time', () => {
  test('displays a UTC instant in the airport zone', () => {
    // 08:00 UTC is 09:00 in Lagos (UTC+1, no DST) and 08:00 in London in November (GMT).
    const lagos = formatLocalTime('2026-11-12T08:00:00Z', 'Africa/Lagos');
    const london = formatLocalTime('2026-11-12T08:00:00Z', 'Europe/London');
    assert.match(lagos, /09:00/);
    assert.match(london, /08:00/);
  });

  test('computes durations and rejects reversed times', () => {
    assert.equal(durationMinutes('2026-11-12T08:00:00Z', '2026-11-12T15:05:00Z'), 425);
    assert.throws(() => durationMinutes('2026-11-12T10:00:00Z', '2026-11-12T08:00:00Z'), RangeError);
  });
});
