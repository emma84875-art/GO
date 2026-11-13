// Role-based views of passenger data. Passenger details are restricted by role:
//   customer: names and ticket numbers for their own booking, no date of birth or nationality.
//   support:  everything the booking needs to resolve a problem, except the ticket number
//             in full (masked to the last 4) because support rarely needs the whole number.
//   finance:  booking totals and references only, no personal details.
// Logs and audit entries never receive passenger fields. Passport and document numbers are
// not part of this model at all (see docs/10).

import type { HoldPassenger, TicketDocument } from '../../flights/src/supplier.ts';

export type Role = 'customer' | 'support' | 'finance';

export interface PassengerView {
  readonly index: number;
  readonly name: string;
  readonly dateOfBirth?: string;
  readonly nationality?: string;
}

export interface TicketView {
  readonly passengerIndex: number;
  readonly number: string; // full for customer, masked for support, absent for finance
}

export function passengersFor(role: Role, passengers: readonly HoldPassenger[]): PassengerView[] {
  if (role === 'finance') return [];
  return passengers.map((p, index) => ({
    index,
    name: `${p.firstName} ${p.lastName}`,
    ...(role === 'support' ? { dateOfBirth: p.dateOfBirth, nationality: p.nationality } : {}),
  }));
}

export function ticketsFor(role: Role, documents: readonly TicketDocument[]): TicketView[] {
  if (role === 'finance') return [];
  return documents.map((d) => ({
    passengerIndex: d.passengerIndex,
    number: role === 'customer' ? d.number : `•••${d.number.slice(-4)}`,
  }));
}
