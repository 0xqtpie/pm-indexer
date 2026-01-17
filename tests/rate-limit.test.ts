import { describe, test, expect } from "bun:test";
import { createRateLimiter } from "../src/api/rate-limit.ts";

describe("rate limiter eviction", () => {
  test("evicts least recently used buckets when over limit", () => {
    const limiter = createRateLimiter({ windowMs: 1000, max: 1, maxBuckets: 2 });

    expect(limiter("a").allowed).toBe(true);
    expect(limiter("b").allowed).toBe(true);

    // Touch "a" so "b" becomes LRU
    expect(limiter("a").allowed).toBe(false);

    // Introduce a new key; should evict "b"
    expect(limiter("c").allowed).toBe(true);

    // "b" should be treated as a new bucket after eviction
    const result = limiter("b");
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
  });
});
