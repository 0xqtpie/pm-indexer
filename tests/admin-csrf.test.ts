import { describe, test, expect, mock } from "bun:test";

const mockSyncResult = {
  polymarket: {
    source: "polymarket",
    fetched: 0,
    newMarkets: 0,
    updatedPrices: 0,
    contentChanged: 0,
    embeddingsGenerated: 0,
    errors: [],
    durationMs: 0,
    status: "success",
  },
  kalshi: {
    source: "kalshi",
    fetched: 0,
    newMarkets: 0,
    updatedPrices: 0,
    contentChanged: 0,
    embeddingsGenerated: 0,
    errors: [],
    durationMs: 0,
    status: "success",
  },
  totalDurationMs: 0,
  status: "success",
} as const;

mock.module("../src/services/scheduler/index.ts", () => ({
  triggerIncrementalSync: async () => mockSyncResult,
  triggerFullSync: async () => mockSyncResult,
  isSchedulerRunning: () => false,
}));

describe("admin CSRF enforcement", () => {
  test("requires CSRF token for mutating admin requests", async () => {
    const { default: app } = await import("../src/api/index.ts");
    const { config } = await import("../src/config.ts");

    config.ADMIN_API_KEY = "admin-csrf-key";
    config.ADMIN_CSRF_TOKEN = "csrf-token";

    const res = await app.request("/api/admin/sync", {
      method: "POST",
      headers: {
        "x-admin-key": "admin-csrf-key",
      },
    });
    expect(res.status).toBe(403);

    const resWithToken = await app.request("/api/admin/sync", {
      method: "POST",
      headers: {
        "x-admin-key": "admin-csrf-key",
        "x-csrf-token": "csrf-token",
      },
    });
    expect(resWithToken.status).toBe(200);
  });
});
