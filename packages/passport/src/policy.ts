// Decides whether we may collect passport details for one passenger. Deny by default:
// only a route whose requirement is confirmed as 'required', or 'optional' with the
// customer's consent, collects. The requirement is an input. This module holds no
// route table and no defaults, because no route has been confirmed by a supplier yet.

export type IdentityDocumentRequirement = 'required' | 'optional' | 'not_required' | 'unknown';

export interface CollectionDecision {
  readonly collect: boolean;
  readonly reason: string;
}

export function collectionDecision(
  requirement: IdentityDocumentRequirement,
  customerConsented: boolean,
): CollectionDecision {
  switch (requirement) {
    case 'required':
      return { collect: true, reason: 'required_by_route' };
    case 'optional':
      return customerConsented === true
        ? { collect: true, reason: 'optional_with_consent' }
        : { collect: false, reason: 'optional_without_consent' };
    case 'not_required':
      return { collect: false, reason: 'not_required' };
    default:
      // 'unknown' and any unexpected value.
      return { collect: false, reason: 'requirement_unknown' };
  }
}
