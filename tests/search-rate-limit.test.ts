import { describe, test, expect, mock } from "bun:test";

// Import real modules to preserve exports that aren't being mocked
const realEmbedding = await import("../src/services/embedding/openai.ts");
const realQdrant = await import("../src/services/search/qdrant.ts");

mock.module("../src/services/embedding/openai.ts", () => ({
  ...realEmbedding,
  // Return a proper 1536-dimension vector to avoid Qdrant errors
  generateQueryEmbedding: async () => Array(1536).fill(0.1),
}));

// Note: We don't mock qdrant.ts search because it affects other tests via Bun's
// global mock behavior. The rate limit test works fine with real search - it
// just tests that the rate limiter kicks in after N requests.

describe("search rate limiting", () => {
  test("returns 429 and Retry-After when limit exceeded", async () => {
    const { default: app } = await import("../src/api/index.ts");
    const { config } = await import("../src/config.ts");

    const invalidCursorRes = await app.request(
      "/api/search?q=rate&cursor=not-base64"
    );
    expect(invalidCursorRes.status).toBe(400);
    const invalidJson = await invalidCursorRes.json();
    expect(invalidJson.error.code).toBe("INVALID_CURSOR");

    const limit = config.SEARCH_RATE_LIMIT_MAX + 1;
    let lastResponse: Response | null = null;

    for (let i = 0; i < limit; i += 1) {
      lastResponse = await app.request("/api/search?q=rate%20limit");
    }

    expect(lastResponse?.status).toBe(429);
    const json = await lastResponse?.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(lastResponse?.headers.get("Retry-After")).toBeTruthy();
  });
});
