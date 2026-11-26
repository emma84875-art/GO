// Fixed-window rate limiter.
//
// LIMITATION: state lives in this process's memory. Each instance counts separately, and counts are
// lost on restart. This is correct for a single instance only. Before GO runs more than one instance,
// replace this with a shared store (for example Postgres or Redis) so that every instance counts
// against the same window.
//
// Memory is bounded in two ways:
//   - Expired windows are removed on a schedule: once per window, and more often while the table is large.
//   - The table holds at most MAX_KEYS addresses. When it is full and no window has expired, a NEW address
//     is refused (fail closed) until space is freed. Addresses already counted keep their own limit.

export const MAX_KEYS = 50_000;
const SWEEP_THRESHOLD = 10_000;
const LARGE_TABLE_SWEEP_MS = 1_000;

type Window = { start: number; count: number };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export class FixedWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #maxKeys: number;
  readonly #windows = new Map<string, Window>();
  #lastSweep: number;

  constructor(config: { limit: number; windowSeconds: number }, now: () => number = Date.now, maxKeys: number = MAX_KEYS) {
    if (!isPositiveInteger(config.limit)) throw new TypeError('limit must be a positive integer');
    if (!isPositiveInteger(config.windowSeconds)) {
      throw new TypeError('windowSeconds must be a positive integer');
    }
    if (!isPositiveInteger(maxKeys)) throw new TypeError('maxKeys must be a positive integer');
    this.#limit = config.limit;
    this.#windowMs = config.windowSeconds * 1000;
    this.#now = now;
    this.#maxKeys = maxKeys;
    this.#lastSweep = now();
  }

  // The number of addresses currently held. Exposed for tests and monitoring only.
  get size(): number {
    return this.#windows.size;
  }

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.#now();
    const sweepDue = now - this.#lastSweep >= this.#windowMs
      || (this.#windows.size >= SWEEP_THRESHOLD && now - this.#lastSweep >= LARGE_TABLE_SWEEP_MS);
    if (sweepDue) this.#sweep(now);

    let window = this.#windows.get(key);
    if (window === undefined) {
      // A new address. If the table is full, refuse it rather than grow without limit.
      if (this.#windows.size >= this.#maxKeys) {
        return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(this.#windowMs / 1000)) };
      }
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    } else if (now - window.start >= this.#windowMs) {
      window = { start: now, count: 0 };
      this.#windows.set(key, window);
    }

    if (window.count < this.#limit) {
      window.count += 1;
      return { allowed: true, retryAfterSeconds: 0 };
    }
    const remainingMs = window.start + this.#windowMs - now;
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(remainingMs / 1000)) };
  }

  #sweep(now: number): void {
    this.#lastSweep = now;
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
