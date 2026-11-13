// DEVELOPMENT FIXTURE supplier for orders and tickets. It moves no money and issues no
// real tickets. Ticket numbers are prefixed "FX-" and booking references "FXREF", so they can
// never be mistaken for real ones. Behaviour knobs reproduce failure modes: a lost reply after
// the order was created, delayed ticketing, partial ticketing, and price changes at payment.
// Holds, search and price revalidation come from the flights mock fixture.

import { SupplierUnavailableError, type CancellationOutcome, type CreateOrderResult, type FlightOrderOperations, type FlightSupplier, type HoldPassenger, type Offer, type OrderSnapshot, type TicketDocument } from '../../flights/src/supplier.ts';
import { MockFlightSupplier } from '../../flights/src/adapters/mock.ts';

export interface OrderKnobs {
  readonly timeoutOnCreateAfterCreating?: boolean; // order exists, but the reply is lost
  readonly pollsBeforeTicketing?: number; // reads before documents appear after payment
  readonly ticketSeatsCovered?: 'all' | 'first_only';
  readonly priceChangeOnPay?: boolean;
  readonly timeoutOnPayAfterPaying?: boolean; // payment taken, but the reply is lost
}

interface StoredOrder {
  readonly id: string;
  readonly passengers: readonly HoldPassenger[];
  paid: boolean;
  cancelled: boolean;
  polls: number;
}

export class FixtureOrderSupplier implements FlightSupplier, FlightOrderOperations {
  readonly name = 'fixture-orders';
  readonly mode = 'mock' as const;
  readonly capabilities = { holds: true, orders: true };
  readonly calls: string[] = [];
  private readonly base = new MockFlightSupplier();
  private readonly orders = new Map<string, StoredOrder>();
  private readonly results = new Map<string, unknown>(); // idempotency: same key, same answer
  private nextId = 1;
  knobs: OrderKnobs;

  constructor(knobs: OrderKnobs = {}) {
    this.knobs = knobs;
  }

  search(request: Parameters<MockFlightSupplier['search']>[0]) {
    return this.base.search(request);
  }

  priceOffer(offer: Offer, nowUtc: string) {
    return this.base.priceOffer(offer, nowUtc);
  }

  createHold(offer: Offer, passengers: readonly HoldPassenger[], key: string, nowUtc: string) {
    return this.base.createHold(offer, passengers, key, nowUtc);
  }

  async createOrder(_offer: Offer, passengers: readonly HoldPassenger[], key: string): Promise<CreateOrderResult> {
    this.calls.push('create');
    const existing = this.results.get(key) as CreateOrderResult | undefined;
    if (existing) return existing; // same key never creates a second order
    const id = `FXORD${String(this.nextId++).padStart(4, '0')}`;
    this.orders.set(id, { id, passengers, paid: false, cancelled: false, polls: 0 });
    const result = { orderId: id, snapshot: this.snapshot(id) };
    this.results.set(key, result);
    if (this.knobs.timeoutOnCreateAfterCreating) {
      throw new SupplierUnavailableError('timeout', 'Reply lost after the order was created');
    }
    return result;
  }

  async getOrder(orderId: string): Promise<OrderSnapshot> {
    this.calls.push('get');
    const order = this.orders.get(orderId);
    if (!order) throw new SupplierUnavailableError('order_not_found', 'No such order');
    order.polls += 1;
    return this.snapshot(orderId);
  }

  async payOrder(orderId: string, amountMinor: number, currency: string, key: string): Promise<OrderSnapshot> {
    this.calls.push('pay');
    if (this.results.has(key)) return this.snapshot(orderId); // paid already: do not pay again
    const order = this.orders.get(orderId);
    if (!order) throw new SupplierUnavailableError('order_not_found', 'No such order');
    if (this.knobs.priceChangeOnPay) throw new SupplierUnavailableError('price_changed', 'Price changed before payment');
    order.paid = true;
    this.results.set(key, true);
    if (this.knobs.timeoutOnPayAfterPaying) throw new SupplierUnavailableError('timeout', 'Reply lost after payment');
    void amountMinor;
    void currency;
    return this.snapshot(orderId);
  }

  async cancelOrder(orderId: string, key: string): Promise<CancellationOutcome> {
    this.calls.push('cancel');
    if (this.results.has(key)) return { status: 'confirmed', refundAmountMinor: null };
    const order = this.orders.get(orderId);
    if (!order) throw new SupplierUnavailableError('order_not_found', 'No such order');
    order.cancelled = true;
    this.results.set(key, true);
    return { status: 'confirmed', refundAmountMinor: null };
  }

  // Test helper: how many orders exist, to prove no duplicates were created.
  orderCount(): number {
    return this.orders.size;
  }

  private snapshot(orderId: string): OrderSnapshot {
    const order = this.orders.get(orderId) as StoredOrder;
    const ticketsReady = order.paid && order.polls >= (this.knobs.pollsBeforeTicketing ?? 0);
    const seats = order.passengers.flatMap((p, i) => (p.type === 'infant' ? [] : [i]));
    const covered = this.knobs.ticketSeatsCovered === 'first_only' ? seats.slice(0, 1) : seats;
    const documents: TicketDocument[] = ticketsReady
      ? covered.map((passengerIndex) => ({ type: 'electronic_ticket', number: `FX-${orderId.slice(-4)}${passengerIndex}`, passengerIndex }))
      : [];
    return {
      orderId,
      bookingReference: 'FXREF' + orderId.slice(-2),
      awaitingPayment: !order.paid,
      paymentRequiredByUtc: null,
      documents,
      cancelled: order.cancelled,
      paidAmountMinor: null,
      currency: 'NGN',
    };
  }
}
