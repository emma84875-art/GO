// Fixed-window rate limiter.
//
// LIMITATION: state lives in this process's memory. Each instance counts separately, and counts are
// lost on restart. This is correct for a single instance only. Before GO runs more than one instance,
// replace this with a shared store (for example Postgres or Redis) so that every instance counts
// against the same window.
//
// Memory is bounded by sweeping expired windows once the table grows past SWEEP_THRESHOLD keys.

const SWEEP_THRESHOLD = 10_000;

type Window = { start: number; count: number };

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

export class FixedWindowLimiter {
  readonly #limit: number;
  readonly #windowMs: number;
  readonly #now: () => number;
  readonly #windows = new Map<string, Window>();

  constructor(config: { limit: number; windowSeconds: number }, now: () => number = Date.now) {
    if (!isPositiveInteger(config.limit)) throw new TypeError('limit must be a positive integer');
    if (!isPositiveInteger(config.windowSeconds)) {
      throw new TypeError('windowSeconds must be a positive integer');
    }
    this.#limit = config.limit;
    this.#windowMs = config.windowSeconds * 1000;
    this.#now = now;
  }

  check(key: string): { allowed: boolean; retryAfterSeconds: number } {
    const now = this.#now();
    if (this.#windows.size > SWEEP_THRESHOLD) this.#sweep(now);

    let window = this.#windows.get(key);
    if (window === undefined || now - window.start >= this.#windowMs) {
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
    for (const [key, window] of this.#windows) {
      if (now - window.start >= this.#windowMs) this.#windows.delete(key);
    }
  }
}
