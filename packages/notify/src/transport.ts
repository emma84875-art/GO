// The email transport boundary. The queue depends only on this interface, never on a provider.
//
// Provider adapters must:
//   - send the idempotency key to the provider, so a retried send is not delivered twice (the
//     provider's header name must be verified against its documentation before go-live),
//   - return a stable error code, never the provider's raw error text (it can contain addresses),
//   - report failures as retryable or permanent.
//
// No provider is connected. UnconfiguredTransport reports not_configured and sends nothing.

export interface TransportMessage {
  readonly idempotencyKey: string;
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html: string;
}

export type TransportResult =
  | { readonly state: 'sent'; readonly providerId: string }
  | { readonly state: 'failed'; readonly code: string; readonly retryable: boolean }
  | { readonly state: 'not_configured' };

export interface Transport {
  readonly name: string;
  send(message: TransportMessage): Promise<TransportResult>;
}

export class UnconfiguredTransport implements Transport {
  readonly name = 'unconfigured';
  async send(): Promise<TransportResult> {
    return { state: 'not_configured' };
  }
}

// A test double with provider-side idempotency: a repeated key returns the first result and does
// not record a second delivery. "script" lets a test make the next calls fail in a chosen way.
export class MemoryTransport implements Transport {
  readonly name = 'memory';
  readonly delivered: TransportMessage[] = [];
  readonly attempts: TransportMessage[] = [];
  script: TransportResult[] = [];
  private readonly byKey = new Map<string, TransportResult>();
  private counter = 0;

  async send(message: TransportMessage): Promise<TransportResult> {
    this.attempts.push(message);
    const seen = this.byKey.get(message.idempotencyKey);
    if (seen && seen.state === 'sent') return seen;
    const scripted = this.script.shift();
    if (scripted && scripted.state !== 'sent') return scripted;
    this.counter += 1;
    const result: TransportResult = { state: 'sent', providerId: `mem_${this.counter}` };
    this.delivered.push(message);
    this.byKey.set(message.idempotencyKey, result);
    return scripted ?? result;
  }
}
