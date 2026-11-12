// Booking workflow steps and validation gates. Moving forward requires the current
// step to pass. Moving backward is always allowed, and the draft is never reset, so
// nothing the traveller typed is lost. Payment is not a step here: it belongs to the
// payment module, which only starts after a hold and a fare revalidation.

import { validateContact, type ContactDetails } from './contact.ts';
import { validatePassenger, type PassengerType } from './passenger.ts';
import { documentRequirementFor, validateTravelDocument, type TravelDocument } from './travel-document.ts';

export type BookingStep = 'passengers' | 'contact' | 'review' | 'reserve';

export const STEP_ORDER: readonly BookingStep[] = ['passengers', 'contact', 'review', 'reserve'];

export interface PassengerDraft {
  readonly type: PassengerType;
  readonly firstName: string;
  readonly lastName: string;
  readonly dateOfBirth: string; // YYYY-MM-DD
  readonly nationality: string; // ISO alpha-2
  readonly document?: TravelDocument; // only where the route requires one
}

export interface BookingDraft {
  readonly passengers: readonly PassengerDraft[];
  readonly contact: ContactDetails;
}

export interface BookingContext {
  readonly origin: string;
  readonly destination: string;
  readonly travelDate: string; // YYYY-MM-DD, outbound date
  readonly todayUtc: string; // YYYY-MM-DD
  readonly expected: { readonly adults: number; readonly children: number; readonly infants: number };
}

export const EMPTY_DRAFT: BookingDraft = {
  passengers: [],
  contact: { email: '', phone: '' },
};

export function stepIndex(step: BookingStep): number {
  return STEP_ORDER.indexOf(step);
}

// Errors that stop the traveller leaving this step. Keyed by field path.
export function stepBlockers(step: BookingStep, draft: BookingDraft, context: BookingContext): Record<string, string> {
  if (step === 'passengers') return passengerBlockers(draft, context);
  if (step === 'contact') {
    const result = validateContact(draft.contact);
    return { ...result.errors };
  }
  return {};
}

function passengerBlockers(draft: BookingDraft, context: BookingContext): Record<string, string> {
  const errors: Record<string, string> = {};
  const counts = { adult: 0, child: 0, infant: 0 };
  draft.passengers.forEach((passenger, index) => {
    counts[passenger.type] += 1;
    const result = validatePassenger(passenger, context.travelDate);
    if (!result.valid) {
      errors[`passengers.${index}`] = result.errors.join(' ');
    } else if (result.passengerType !== passenger.type) {
      errors[`passengers.${index}.type`] = `Date of birth makes this traveller a ${result.passengerType}, not a ${passenger.type}.`;
    }
    if (documentRequirementFor(context.origin, context.destination) === 'required') {
      if (!passenger.document) {
        errors[`passengers.${index}.document`] = 'This route requires a travel document.';
      } else {
        const doc = validateTravelDocument(passenger.document, context.todayUtc);
        if (!doc.valid) errors[`passengers.${index}.document`] = Object.values(doc.errors).join(' ');
      }
    }
  });

  if (counts.adult !== context.expected.adults || counts.child !== context.expected.children || counts.infant !== context.expected.infants) {
    errors.passengers = `Enter ${context.expected.adults} adult, ${context.expected.children} child and ${context.expected.infants} infant traveller(s) to match your search.`;
  }
  return errors;
}

// Result of asking to move to a target step. The draft is returned unchanged in every
// case. That is the guarantee that navigation never loses data.
export interface NavigationResult {
  readonly step: BookingStep;
  readonly blockers: Readonly<Record<string, string>>;
  readonly draft: BookingDraft;
}

export function navigate(
  current: BookingStep,
  target: BookingStep,
  draft: BookingDraft,
  context: BookingContext,
): NavigationResult {
  if (stepIndex(target) <= stepIndex(current)) {
    return { step: target, blockers: {}, draft };
  }
  // Moving forward: every step between current and target must pass first.
  for (let i = stepIndex(current); i < stepIndex(target); i += 1) {
    const step = STEP_ORDER[i];
    const blockers = stepBlockers(step, draft, context);
    if (Object.keys(blockers).length > 0) {
      return { step, blockers, draft };
    }
  }
  return { step: target, blockers: {}, draft };
}
