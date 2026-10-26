/**
 * Failed-sign-in limiter for the HTTP bridge.
 *
 * Counts wrong bearer tokens and wrong access keys per client address in a
 * sliding window; once a client reaches the limit it is refused (429) until
 * its oldest failure ages out. State lives in this process only, so on a
 * serverless platform each warm instance counts on its own: this slows
 * guessing down, and a platform firewall rule (Vercel Firewall rate limits)
 * is the stronger layer on top.
 */

export interface AttemptLimiterOptions {
  /** Failures allowed per client inside the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
  /** Clock in seconds; tests override it. */
  now?: () => number;
}

export interface AttemptLimiter {
  /** Seconds until the client may try again, or 0 when it is not limited. */
  retryAfter(client: string): number;
  /** Record one failed attempt by the client. */
  fail(client: string): void;
}

/** Distinct clients tracked at once; the oldest entry is dropped past this. */
const MAX_CLIENTS = 10_000;

export function createAttemptLimiter(options: AttemptLimiterOptions): AttemptLimiter {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const failures = new Map<string, number[]>();

  function recent(client: string): number[] {
    const cutoff = now() - options.windowSeconds;
    const times = (failures.get(client) ?? []).filter((time) => time > cutoff);
    if (times.length === 0) failures.delete(client);
    else failures.set(client, times);
    return times;
  }

  return {
    retryAfter(client) {
      const times = recent(client);
      if (times.length < options.max) return 0;
      return Math.max(1, times[times.length - options.max] + options.windowSeconds - now());
    },
    fail(client) {
      const times = recent(client);
      times.push(now());
      // Re-insert so Map order tracks the most recent failure.
      failures.delete(client);
      failures.set(client, times.slice(-options.max));
      if (failures.size > MAX_CLIENTS) {
        const oldest = failures.keys().next().value;
        if (oldest !== undefined) failures.delete(oldest);
      }
    },
  };
}

/**
 * The caller's address as the platform reports it. Vercel sets x-real-ip and
 * x-forwarded-for itself; elsewhere these headers can be forged, so behind
 * no proxy the limiter is only as good as the headers it is given.
 */
export function clientAddress(request: Request): string {
  const real = request.headers.get('x-real-ip')?.trim();
  if (real) return real;
  const forwarded = request.headers.get('x-forwarded-for')?.split(',')[0].trim();
  return forwarded || 'unknown';
}
