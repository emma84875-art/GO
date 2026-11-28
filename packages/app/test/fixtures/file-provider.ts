// A payment provider double whose state lives in a file, so separate test processes share what the provider has done,
// as they would with a real provider. It is test-only. It makes no network call. Signature and webhook parsing come from
// the fixture adapter. Each reference records how many times the provider was asked to initiate it, so a test can check
// the provider's own record, not the application's.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { FixturePaymentProvider } from '../../../payments/src/adapters/fixture.ts';
import type { InitiateRequest, InitiateResult, PaymentProvider, ProviderCapabilities, ProviderStatus, WebhookVerification, ParsedWebhook } from '../../../payments/src/provider.ts';

interface ProviderRecord {
  readonly providerRef: string;
  readonly amountMinor: number;
  readonly currency: string;
  readonly state: ProviderStatus['state'];
  readonly initiates: number;
}

export class FileBackedFixturePaymentProvider implements PaymentProvider {
  readonly name = 'fixture';
  readonly mode = 'fixture' as const;
  readonly capabilities: ProviderCapabilities;
  readonly #path: string;
  readonly #inner: FixturePaymentProvider;

  constructor(path: string, secret: string) {
    this.#path = path;
    this.#inner = new FixturePaymentProvider(secret);
    this.capabilities = this.#inner.capabilities;
  }

  #read(): Record<string, ProviderRecord> {
    return existsSync(this.#path) ? (JSON.parse(readFileSync(this.#path, 'utf8')) as Record<string, ProviderRecord>) : {};
  }

  #write(records: Record<string, ProviderRecord>): void {
    writeFileSync(this.#path, JSON.stringify(records));
  }

  // How many times the provider has been asked to initiate this reference, as the provider recorded it.
  initiateCount(reference: string): number {
    return this.#read()[reference]?.initiates ?? 0;
  }

  async initiate(request: InitiateRequest): Promise<InitiateResult> {
    const records = this.#read();
    const providerRef = `fx_${request.reference.replace(/[^a-z0-9]+/gi, '_')}`;
    const previous = records[request.reference];
    records[request.reference] = {
      providerRef,
      amountMinor: request.amount.amountMinor,
      currency: request.amount.currency,
      state: 'pending',
      initiates: (previous?.initiates ?? 0) + 1,
    };
    this.#write(records);
    return { providerRef, redirectUrl: `https://fixture.invalid/pay/${providerRef}` };
  }

  async findByReference(reference: string): Promise<{ providerRef: string; status: ProviderStatus } | null> {
    const record = this.#read()[reference];
    if (!record) return null;
    return {
      providerRef: record.providerRef,
      status: { state: record.state, amount: { amountMinor: record.amountMinor, currency: record.currency as never } },
    };
  }

  async getStatus(providerRef: string): Promise<ProviderStatus> {
    const record = Object.values(this.#read()).find((r) => r.providerRef === providerRef);
    if (!record) throw new Error('unknown provider reference');
    return { state: record.state, amount: { amountMinor: record.amountMinor, currency: record.currency as never } };
  }

  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string | undefined>>): WebhookVerification {
    return this.#inner.verifyWebhook(rawBody, headers);
  }

  parseWebhook(rawBody: string): ParsedWebhook {
    return this.#inner.parseWebhook(rawBody);
  }

  sign(rawBody: string): string {
    return this.#inner.sign(rawBody);
  }
}
