export interface RateLimitOptions {
  windowMs: number;
  max: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
}

export function createRateLimiter(options: RateLimitOptions) {
  const buckets = new Map<string, { count: number; resetAt: number }>();

  return (key: string): RateLimitResult => {
    if (options.max <= 0) {
      return { allowed: true, remaining: options.max, resetAt: Date.now() };
    }

    const now = Date.now();
    const bucket = buckets.get(key);

    if (!bucket || now >= bucket.resetAt) {
      const resetAt = now + options.windowMs;
      buckets.set(key, { count: 1, resetAt });
      return { allowed: true, remaining: options.max - 1, resetAt };
    }

    if (bucket.count >= options.max) {
      return { allowed: false, remaining: 0, resetAt: bucket.resetAt };
    }

    bucket.count += 1;
    return { allowed: true, remaining: options.max - bucket.count, resetAt: bucket.resetAt };
  };
}
