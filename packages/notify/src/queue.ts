// Notification queue: enqueue with idempotency and preferences, then deliver in the background.
//
// Guarantees:
//   - Idempotency: a request with a key already seen is returned as a duplicate. The key is built
//     from the entity and its state, so a repeated state does not send again, and a new state does.
//   - Preferences: optional messages are suppressed when the customer has switched them off.
//   - Rate limit: authentication messages (verify, reset) are capped per user per hour.
//   - Delivery: each attempt claims the job first. Transient failures retry with backoff. Permanent
//     failures stop. After maxAttempts the job is dead. Stale claims (a crash mid-send) are
//     released for retry with the same idempotency key, so the provider does not send twice.
//   - Daily cap: deliveries stop at dailySendCap, to stay inside a free tier. Remaining jobs wait
//     for the next UTC day.
//   - Privacy: the queue never stores an email address, a rendered body or a link. Once a job is
//     sent, failed for good, or dead, its data is cleared. Failure log entries hold only codes.
//
// The background worker is expected to call processDue on a schedule. In production this is
// intended to be pg-boss (approved in the earlier stack decisions). It is not installed yet, so
// this queue is in-memory and is for development and tests.

import type { RenderedEmail } from './render.ts';
import type { NotificationRequest } from './requests.ts';
import { preferenceAllows, type Preferences } from './preferences.ts';
import type { Transport } from './transport.ts';
import type { TemplateId } from './templates.ts';

export type JobState = 'queued' | 'sending' | 'retry_scheduled' | 'sent' | 'failed' | 'dead' | 'suppressed';

export interface Job {
  readonly id: string;
  readonly idempotencyKey: string;
  readonly template: TemplateId;
  readonly userId: string;
  readonly state: JobState;
  readonly attempts: number;
  readonly nextAttemptAt: string | null;
  readonly claimedAt: string | null;
  readonly createdAt: string;
  readonly sentAt: string | null;
  readonly providerId: string | null;
  readonly lastErrorCode: string | null;
  readonly suppressedReason: string | null;
  readonly data: Record<string, unknown> | null; // cleared once the job is final
}

export interface FailureLogEntry {
  readonly at: string;
  readonly jobId: string;
  readonly template: TemplateId;
  readonly code: string;
  readonly attempt: number;
  readonly retryable: boolean;
}

export interface QueueConfig {
  readonly dailySendCap: number;
  readonly maxAttempts: number;
  readonly backoffSeconds: readonly number[];
  readonly authLimitPerHour: number;
  readonly batchSize: number;
  readonly staleClaimMs: number;
  readonly notConfiguredRetrySeconds: number;
}

export const DEFAULT_CONFIG: QueueConfig = Object.freeze({
  dailySendCap: 100, // the free-tier limit of the provider recommended in docs/17
  maxAttempts: 5,
  backoffSeconds: [60, 300, 900, 3600, 21600],
  authLimitPerHour: 5,
  batchSize: 50,
  staleClaimMs: 10 * 60_000,
  notConfiguredRetrySeconds: 900,
});

export type EnqueueResult =
  | { readonly status: 'queued'; readonly jobId: string }
  | { readonly status: 'duplicate'; readonly jobId: string }
  | { readonly status: 'suppressed'; readonly jobId: string; readonly reason: string };

export interface ProcessDeps {
  readonly transport: Transport;
  readonly addressFor: (userId: string) => Promise<string | null>;
  readonly render: (job: { readonly template: TemplateId; readonly data: Record<string, unknown>; readonly userId: string }) => RenderedEmail;
}

export interface ProcessReport {
  readonly sent: number;
  readonly retried: number;
  readonly failed: number;
  readonly dead: number;
  readonly deferredByCap: number;
  readonly notConfigured: number;
}

const AUTH_TEMPLATES: readonly TemplateId[] = ['account_verification', 'password_reset'];

function addSeconds(iso: string, seconds: number): string {
  return new Date(Date.parse(iso) + seconds * 1000).toISOString();
}

function nextUtcMidnight(iso: string): string {
  const d = new Date(iso);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1)).toISOString();
}

function sameUtcDay(a: string, b: string): boolean {
  return a.slice(0, 10) === b.slice(0, 10);
}

export class NotificationQueue {
  private readonly config: QueueConfig;
  private readonly jobs = new Map<string, Job>();
  private readonly byKey = new Map<string, string>();
  private readonly failures: FailureLogEntry[] = [];
  private seq = 0;

  constructor(config: Partial<QueueConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  get failureLog(): readonly FailureLogEntry[] {
    return [...this.failures];
  }

  job(id: string): Job | undefined {
    return this.jobs.get(id);
  }

  allJobs(): readonly Job[] {
    return [...this.jobs.values()];
  }

  enqueue(request: NotificationRequest, prefs: Preferences, nowUtc: string): EnqueueResult {
    const existingId = this.byKey.get(request.idempotencyKey);
    if (existingId) return { status: 'duplicate', jobId: existingId };

    const id = `NJ-${String(++this.seq).padStart(6, '0')}`;
    const base = {
      id,
      idempotencyKey: request.idempotencyKey,
      template: request.template,
      userId: request.userId,
      attempts: 0,
      claimedAt: null,
      createdAt: nowUtc,
      sentAt: null,
      providerId: null,
      lastErrorCode: null,
      data: request.data,
    };

    const pref = preferenceAllows(request, prefs);
    if (!pref.allowed) {
      this.store({ ...base, state: 'suppressed', nextAttemptAt: null, suppressedReason: pref.reason, data: null });
      return { status: 'suppressed', jobId: id, reason: pref.reason ?? 'preference' };
    }

    if (AUTH_TEMPLATES.includes(request.template)) {
      const since = Date.parse(nowUtc) - 60 * 60_000;
      const recent = [...this.jobs.values()].filter(
        (j) => j.userId === request.userId && j.template === request.template && j.state !== 'suppressed' && Date.parse(j.createdAt) >= since,
      ).length;
      if (recent >= this.config.authLimitPerHour) {
        this.store({ ...base, state: 'suppressed', nextAttemptAt: null, suppressedReason: 'rate_limited', data: null });
        return { status: 'suppressed', jobId: id, reason: 'rate_limited' };
      }
    }

    this.store({ ...base, state: 'queued', nextAttemptAt: nowUtc, suppressedReason: null });
    return { status: 'queued', jobId: id };
  }

  private store(job: Job): void {
    this.jobs.set(job.id, job);
    this.byKey.set(job.idempotencyKey, job.id);
  }

  private update(id: string, patch: Partial<Job>): Job {
    const current = this.jobs.get(id);
    if (!current) throw new Error('job_not_found');
    const next = { ...current, ...patch } as Job;
    this.jobs.set(id, next);
    return next;
  }

  private logFailure(job: Job, at: string, code: string, retryable: boolean): void {
    this.failures.push({ at, jobId: job.id, template: job.template, code, attempt: job.attempts, retryable });
  }

  // Releases jobs whose claim is older than staleClaimMs (a crash during a send). They are retried
  // with the same idempotency key.
  releaseStaleClaims(nowUtc: string): number {
    let released = 0;
    for (const job of this.jobs.values()) {
      if (job.state === 'sending' && job.claimedAt && Date.parse(nowUtc) - Date.parse(job.claimedAt) > this.config.staleClaimMs) {
        this.update(job.id, { state: 'retry_scheduled', nextAttemptAt: nowUtc, claimedAt: null });
        this.logFailure(job, nowUtc, 'stale_claim', true);
        released += 1;
      }
    }
    return released;
  }

  async processDue(nowUtc: string, deps: ProcessDeps): Promise<ProcessReport> {
    const report = { sent: 0, retried: 0, failed: 0, dead: 0, deferredByCap: 0, notConfigured: 0 };
    const sentToday = () => [...this.jobs.values()].filter((j) => j.sentAt && sameUtcDay(j.sentAt, nowUtc)).length;

    const due = [...this.jobs.values()]
      .filter((j) => (j.state === 'queued' || j.state === 'retry_scheduled') && j.nextAttemptAt !== null && Date.parse(j.nextAttemptAt) <= Date.parse(nowUtc))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
      .slice(0, this.config.batchSize);

    for (let i = 0; i < due.length; i += 1) {
      if (sentToday() >= this.config.dailySendCap) {
        // The cap is reached: the remaining due jobs wait for the next UTC day.
        const midnight = nextUtcMidnight(nowUtc);
        for (const j of due.slice(i)) this.update(j.id, { nextAttemptAt: midnight });
        report.deferredByCap = due.length - i;
        break;
      }
      await this.deliver(due[i], nowUtc, deps, report);
    }
    return report;
  }

  private async deliver(job: Job, nowUtc: string, deps: ProcessDeps, report: { sent: number; retried: number; failed: number; dead: number; notConfigured: number }): Promise<void> {
    const attempt = job.attempts + 1;
    this.update(job.id, { state: 'sending', claimedAt: nowUtc });

    const finalise = (patch: Partial<Job>, code: string | null) => {
      if (code !== null) this.logFailure({ ...job, attempts: attempt }, nowUtc, code, false);
      return this.update(job.id, { ...patch, data: null, claimedAt: null });
    };

    let address: string | null;
    try {
      address = await deps.addressFor(job.userId);
    } catch {
      this.failTransient(job, attempt, nowUtc, 'address_error', report);
      return;
    }
    if (address === null) {
      finalise({ state: 'failed', attempts: attempt, lastErrorCode: 'no_address', nextAttemptAt: null }, 'no_address');
      report.failed += 1;
      return;
    }

    let rendered: RenderedEmail;
    try {
      rendered = deps.render({ template: job.template, data: job.data ?? {}, userId: job.userId });
    } catch {
      finalise({ state: 'failed', attempts: attempt, lastErrorCode: 'render_error', nextAttemptAt: null }, 'render_error');
      report.failed += 1;
      return;
    }

    let result;
    try {
      result = await deps.transport.send({ idempotencyKey: job.idempotencyKey, to: address, subject: rendered.subject, text: rendered.text, html: rendered.html });
    } catch {
      this.failTransient(job, attempt, nowUtc, 'transport_error', report);
      return;
    }

    if (result.state === 'sent') {
      this.update(job.id, { state: 'sent', attempts: attempt, sentAt: nowUtc, providerId: result.providerId, data: null, claimedAt: null, nextAttemptAt: null, lastErrorCode: null });
      report.sent += 1;
      return;
    }
    if (result.state === 'not_configured') {
      this.update(job.id, {
        state: 'queued',
        attempts: job.attempts,
        claimedAt: null,
        nextAttemptAt: addSeconds(nowUtc, this.config.notConfiguredRetrySeconds),
        lastErrorCode: 'not_configured',
      });
      report.notConfigured += 1;
      return;
    }
    if (!result.retryable) {
      finalise({ state: 'failed', attempts: attempt, lastErrorCode: result.code, nextAttemptAt: null }, result.code);
      report.failed += 1;
      return;
    }
    this.failTransient(job, attempt, nowUtc, result.code, report);
  }

  private failTransient(job: Job, attempt: number, nowUtc: string, code: string, report: { retried: number; dead: number }): void {
    this.logFailure({ ...job, attempts: attempt }, nowUtc, code, true);
    if (attempt >= this.config.maxAttempts) {
      this.update(job.id, { state: 'dead', attempts: attempt, lastErrorCode: code, nextAttemptAt: null, data: null, claimedAt: null });
      report.dead += 1;
      return;
    }
    const wait = this.config.backoffSeconds[Math.min(attempt - 1, this.config.backoffSeconds.length - 1)];
    this.update(job.id, { state: 'retry_scheduled', attempts: attempt, lastErrorCode: code, nextAttemptAt: addSeconds(nowUtc, wait), claimedAt: null });
    report.retried += 1;
  }
}
