import { describe, test, expect, mock } from "bun:test";

mock.module("../src/services/embedding/openai.ts", () => ({
  generateQueryEmbedding: async () => [0.1, 0.2],
}));

mock.module("../src/services/search/qdrant.ts", () => ({
  search: async () => [],
  recommendMarkets: async () => [],
}));

describe("search rate limiting", () => {
  test("returns 429 and Retry-After when limit exceeded", async () => {
    const { default: app } = await import("../src/api/routes.ts");
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
