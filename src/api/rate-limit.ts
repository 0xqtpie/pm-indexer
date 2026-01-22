/**
 * In-memory rate limiter for single-instance deployments.
 *
 * IMPORTANT: This implementation stores state in memory and is suitable for
 * single-instance deployments only. For production systems with multiple
 * instances or load balancers, use a Redis-based rate limiter instead.
 */

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  maxBuckets?: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

/**
 * In-memory sliding window rate limiter.
 *
 * LIMITATIONS:
 * - State lost on process restart
 * - Per-instance only (no cluster coordination)
 * - For production with multiple instances, use Redis-based implementation
 *
 * @param options - Rate limit configuration
 * @returns Rate limiter function
 */
export function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, { count: number; resetAt: number }>();
  const maxBuckets = options.maxBuckets ?? 5000;

  function touch(key: string, bucket: { count: number; resetAt: number }) {
    buckets.delete(key);
    buckets.set(key, bucket);
  }

  function evictIfNeeded(now: number) {
    if (maxBuckets <= 0 || buckets.size <= maxBuckets) {
      return;
    }

    for (const [key, bucket] of buckets) {
      if (now < bucket.resetAt) {
        continue;
      }
      buckets.delete(key);
    }

    while (buckets.size > maxBuckets) {
      const oldestKey = buckets.keys().next().value as string | undefined;
      if (!oldestKey) break;
      buckets.delete(oldestKey);
    }
  }

  return (key: string): RateLimitResult => {
    if (options.max <= 0) {
      return { allowed: true, remaining: options.max, resetAt: Date.now() };
    }

    const now = Date.now();
    evictIfNeeded(now);
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      const resetAt = now + options.windowMs;
      const nextBucket = { count: 1, resetAt };
      touch(key, nextBucket);
      return { allowed: true, remaining: options.max - 1, resetAt };
    }

    if (bucket.count >= options.max) {
      touch(key, bucket);
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }

    bucket.count += 1;
    touch(key, bucket);
    return {
      allowed: true,
      remaining: options.max - bucket.count,
      resetAt: bucket.resetAt,
    };
  };
}
