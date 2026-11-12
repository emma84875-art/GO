import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { validateInternationalPhone } from '../src/phone.ts';
import { validateContact } from '../src/contact.ts';
import { documentRequirementFor, validateTravelDocument, maskDocumentNumber } from '../src/travel-document.ts';
import { newBookingReference, REFERENCE_PATTERN } from '../src/booking-reference.ts';
import { holdExpiryState, minutesRemaining } from '../src/hold-expiry.ts';
import { navigate, stepBlockers, EMPTY_DRAFT, type BookingContext, type BookingDraft } from '../src/booking-workflow.ts';

const TODAY = '2026-11-12';

describe('international phone', () => {
  test('accepts E.164 with common separators', () => {
    assert.deepEqual(validateInternationalPhone('+234 803 123 4567'), { valid: true, e164: '+2348031234567' });
    assert.equal(validateInternationalPhone('+44 (20) 7946-0958').valid, true);
  });

  test('requires a leading plus and sensible length', () => {
    assert.match(validateInternationalPhone('08031234567').error ?? '', /country code/);
    assert.equal(validateInternationalPhone('+123').valid, false);
    assert.equal(validateInternationalPhone('+1234567890123456').valid, false);
    assert.equal(validateInternationalPhone('').valid, false);
  });

  test('rejects letters and a leading zero after the plus', () => {
    assert.equal(validateInternationalPhone('+234abc1234567').valid, false);
    assert.equal(validateInternationalPhone('+0234803123456').valid, false);
  });
});

describe('contact details', () => {
  test('accepts a valid email and phone', () => {
    assert.equal(validateContact({ email: 'ada@example.com', phone: '+2348031234567' }).valid, true);
  });

  test('flags a bad email and a bad phone separately', () => {
    const result = validateContact({ email: 'ada@', phone: '0803' });
    assert.ok(result.errors.email);
    assert.ok(result.errors.phone);
  });
});

describe('travel documents', () => {
  test('no route is treated as requiring a document until confirmed', () => {
    assert.equal(documentRequirementFor('LOS', 'LHR'), 'unconfirmed');
  });

  test('validates number, issuing country and an unexpired expiry date', () => {
    const ok = validateTravelDocument({ number: 'a1234567', issuingCountry: 'NG', expiryDate: '2030-01-01' }, TODAY);
    assert.equal(ok.valid, true);
    assert.equal(validateTravelDocument({ number: '12', issuingCountry: 'NG', expiryDate: '2030-01-01' }, TODAY).valid, false);
    assert.equal(validateTravelDocument({ number: 'A1234567', issuingCountry: 'ZZ', expiryDate: '2030-01-01' }, TODAY).valid, false);
    assert.match(validateTravelDocument({ number: 'A1234567', issuingCountry: 'NG', expiryDate: '2020-01-01' }, TODAY).errors.expiryDate ?? '', /expired/);
  });

  test('masks document numbers for display', () => {
    assert.equal(maskDocumentNumber('A12345678'), '•••678');
    assert.equal(maskDocumentNumber('AB'), '•••');
  });
});

describe('booking references', () => {
  test('always match the pattern and never use ambiguous characters', () => {
    for (let i = 0; i < 200; i += 1) {
      const ref = newBookingReference();
      assert.match(ref, REFERENCE_PATTERN);
      assert.doesNotMatch(ref, /[IO01]/);
    }
  });

  test('uses the supplied bytes deterministically', () => {
    assert.equal(newBookingReference(() => new Uint8Array([0, 1, 2, 3, 4, 5])), 'ABCDEF');
  });
});

describe('hold expiry', () => {
  const expires = '2026-11-12T10:00:00Z';

  test('active, expiring soon and expired by remaining time', () => {
    assert.equal(holdExpiryState(expires, '2026-11-12T09:00:00Z'), 'active');
    assert.equal(holdExpiryState(expires, '2026-11-12T09:55:00Z'), 'expiring_soon');
    assert.equal(holdExpiryState(expires, '2026-11-12T10:00:00Z'), 'expired');
    assert.equal(holdExpiryState(expires, '2026-11-12T11:00:00Z'), 'expired');
  });

  test('minutes remaining never goes negative', () => {
    assert.equal(minutesRemaining(expires, '2026-11-12T09:30:00Z'), 30);
    assert.equal(minutesRemaining(expires, '2026-11-12T12:00:00Z'), 0);
  });

  test('rejects invalid timestamps rather than guessing', () => {
    assert.throws(() => holdExpiryState('not a time', TODAY), RangeError);
  });
});

describe('booking workflow', () => {
  const context: BookingContext = {
    origin: 'LOS',
    destination: 'LHR',
    travelDate: '2026-12-01',
    todayUtc: TODAY,
    expected: { adults: 1, children: 1, infants: 0 },
  };

  const adult = { type: 'adult' as const, firstName: 'Ada', lastName: 'Okafor', dateOfBirth: '1990-05-14', nationality: 'NG' };
  const child = { type: 'child' as const, firstName: 'Tobi', lastName: 'Okafor', dateOfBirth: '2018-03-02', nationality: 'NG' };

  const complete: BookingDraft = {
    passengers: [adult, child],
    contact: { email: 'ada@example.com', phone: '+2348031234567' },
  };

  test('a complete draft has no blockers on any step', () => {
    assert.deepEqual(stepBlockers('passengers', complete, context), {});
    assert.deepEqual(stepBlockers('contact', complete, context), {});
  });

  test('passenger count must match the search', () => {
    const draft = { ...complete, passengers: [adult] };
    assert.match(stepBlockers('passengers', draft, context).passengers ?? '', /Enter 1 adult, 1 child/);
  });

  test('a declared type must match the date of birth', () => {
    const wrong = { ...complete, passengers: [adult, { ...child, type: 'infant' as const }] };
    assert.ok(stepBlockers('passengers', wrong, context)['passengers.1.type']);
  });

  test('moving forward is blocked by errors and reports the step that blocked', () => {
    const result = navigate('passengers', 'review', { ...complete, contact: { email: '', phone: '' } }, context);
    assert.equal(result.step, 'contact');
    assert.ok(result.blockers.email);
  });

  test('moving backward is always allowed and keeps every typed value', () => {
    const draft: BookingDraft = { ...complete, contact: { email: 'half@typed', phone: '' } };
    const back = navigate('contact', 'passengers', draft, context);
    assert.equal(back.step, 'passengers');
    assert.strictEqual(back.draft, draft);
  });

  test('navigation never changes the draft in any direction', () => {
    const forward = navigate('passengers', 'contact', complete, context);
    assert.strictEqual(forward.draft, complete);
    assert.deepEqual(forward.draft.passengers, complete.passengers);
  });

  test('an empty draft cannot leave the passengers step', () => {
    const result = navigate('passengers', 'contact', EMPTY_DRAFT, context);
    assert.equal(result.step, 'passengers');
  });
});
