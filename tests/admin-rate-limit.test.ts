import { describe, test, expect } from "bun:test";

describe("admin rate limiting", () => {
  test("returns 429 after exceeding admin burst limit", async () => {
    const { default: app } = await import("../src/api/index.ts");
    const { config } = await import("../src/config.ts");

    config.ADMIN_API_KEY = "admin-rate-key";

    const headers = { "x-admin-key": "admin-rate-key" };
    const limit = config.ADMIN_RATE_LIMIT_MAX + 1;
    let lastResponse: Response | null = null;

    for (let i = 0; i < limit; i += 1) {
      lastResponse = await app.request("/api/admin/sync/status", { headers });
    }

    expect(lastResponse?.status).toBe(429);

    const json = await lastResponse?.json();
    expect(json.error.code).toBe("RATE_LIMITED");
    expect(lastResponse?.headers.get("Retry-After")).toBeTruthy();
  });
});
