import { describe, test, expect, mock, beforeEach, afterEach } from "bun:test";

// We'll test the retry utility and health check functions
// These tests verify the resilience layer works correctly

describe("Qdrant Resilience", () => {
  describe("withRetry utility", () => {
    test("returns result on first success", async () => {
      // Import after defining to get fresh module
      const { withRetry } = await import(
        "../src/services/search/qdrant-retry.ts"
      );

      const fn = mock(() => Promise.resolve("success"));
      const result = await withRetry(fn);

      expect(result).toBe("success");
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test("retries on failure and succeeds", async () => {
      const { withRetry } = await import(
        "../src/services/search/qdrant-retry.ts"
      );

      let attempt = 0;
      const fn = mock(() => {
        attempt++;
        if (attempt < 3) {
          return Promise.reject(new Error(`Attempt ${attempt} failed`));
        }
        return Promise.resolve("success after retries");
      });

      const result = await withRetry(fn, { baseDelayMs: 10 });

      expect(result).toBe("success after retries");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test("throws after max attempts exceeded", async () => {
      const { withRetry } = await import(
        "../src/services/search/qdrant-retry.ts"
      );

      const fn = mock(() => Promise.reject(new Error("Always fails")));

      await expect(
        withRetry(fn, { maxAttempts: 3, baseDelayMs: 10 })
      ).rejects.toThrow("Always fails");

      expect(fn).toHaveBeenCalledTimes(3);
    });

    test("respects maxAttempts option", async () => {
      const { withRetry } = await import(
        "../src/services/search/qdrant-retry.ts"
      );

      const fn = mock(() => Promise.reject(new Error("Fail")));

      await expect(
        withRetry(fn, { maxAttempts: 5, baseDelayMs: 10 })
      ).rejects.toThrow();

      expect(fn).toHaveBeenCalledTimes(5);
    });

    test("uses exponential backoff with jitter", async () => {
      const { withRetry } = await import(
        "../src/services/search/qdrant-retry.ts"
      );

      const timestamps: number[] = [];
      let attempt = 0;
      const fn = mock(() => {
        timestamps.push(Date.now());
        attempt++;
        if (attempt < 3) {
          return Promise.reject(new Error("Fail"));
        }
        return Promise.resolve("done");
      });

      await withRetry(fn, { baseDelayMs: 50, maxDelayMs: 500 });

      // Check that delays occurred (with some tolerance for jitter)
      expect(timestamps.length).toBe(3);
      const delay1 = timestamps[1] - timestamps[0];
      const delay2 = timestamps[2] - timestamps[1];

      // First delay should be around 50ms (baseDelayMs * 2^0)
      expect(delay1).toBeGreaterThanOrEqual(40);
      expect(delay1).toBeLessThan(100);

      // Second delay should be around 100ms (baseDelayMs * 2^1)
      expect(delay2).toBeGreaterThanOrEqual(80);
      expect(delay2).toBeLessThan(200);
    });

    test("caps delay at maxDelayMs", async () => {
      const { withRetry } = await import(
        "../src/services/search/qdrant-retry.ts"
      );

      const timestamps: number[] = [];
      let attempt = 0;
      const fn = mock(() => {
        timestamps.push(Date.now());
        attempt++;
        if (attempt < 4) {
          return Promise.reject(new Error("Fail"));
        }
        return Promise.resolve("done");
      });

      await withRetry(fn, {
        maxAttempts: 5,
        baseDelayMs: 100,
        maxDelayMs: 150,
      });

      // With base=100, maxDelay=150:
      // Attempt 2: min(100 * 2^0, 150) = 100ms
      // Attempt 3: min(100 * 2^1, 150) = 150ms (capped)
      // Attempt 4: min(100 * 2^2, 150) = 150ms (capped)
      const delay3 = timestamps[3] - timestamps[2];
      expect(delay3).toBeLessThan(200); // Should be capped around 150ms + jitter
    });
  });

  describe("checkQdrantHealth", () => {
    test("returns true when Qdrant is accessible", async () => {
      const { checkQdrantHealth } = await import(
        "../src/services/search/qdrant.ts"
      );

      // This is an integration test - requires Qdrant to be running
      const isHealthy = await checkQdrantHealth();
      expect(isHealthy).toBe(true);
    });
  });

  describe("Health endpoint integration", () => {
    test("/ready endpoint returns healthy status", async () => {
      // Import the app to test the endpoint
      const { default: app } = await import("../src/api/index.ts");

      const response = await app.request("/ready");
      expect(response.status).toBe(200);

      const body = await response.json();
      expect(body.status).toBe("healthy");
      expect(body.qdrant).toBe(true);
    });

    test("/ready endpoint includes timestamp", async () => {
      const { default: app } = await import("../src/api/index.ts");

      const response = await app.request("/ready");
      const body = await response.json();

      expect(body).toHaveProperty("timestamp");
      // Validate it's a valid ISO timestamp
      expect(() => new Date(body.timestamp)).not.toThrow();
    });
  });
});
