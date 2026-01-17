import { describe, test, expect, mock } from "bun:test";
import { and, eq, gte, inArray } from "drizzle-orm";

const mockSyncResult = {
  polymarket: {
    source: "polymarket",
    fetched: 0,
    newMarkets: 0,
    updatedPrices: 0,
    contentChanged: 0,
    embeddingsGenerated: 0,
    errors: [],
    durationMs: 5,
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
    durationMs: 5,
    status: "success",
  },
  totalDurationMs: 10,
  status: "success",
} as const;

mock.module("../src/services/scheduler/index.ts", () => ({
  triggerIncrementalSync: async () => mockSyncResult,
  triggerFullSync: async () => mockSyncResult,
  isSchedulerRunning: () => false,
}));

describe("admin audit logging", () => {
  test("records audit logs on admin sync actions", async () => {
    const startedAt = new Date();
    const { default: app } = await import("../src/api/routes.ts");
    const { config } = await import("../src/config.ts");
    const { db, adminAuditLogs } = await import("../src/db/index.ts");

    config.ADMIN_API_KEY = "admin-audit-key";

    const res = await app.request("/api/admin/sync", {
      method: "POST",
      headers: {
        "x-admin-key": "admin-audit-key",
      },
    });

    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(adminAuditLogs)
      .where(
        and(
          eq(adminAuditLogs.action, "sync.incremental"),
          gte(adminAuditLogs.createdAt, startedAt)
        )
      );

    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]?.status).toBe("success");

    if (rows.length > 0) {
      await db
        .delete(adminAuditLogs)
        .where(inArray(adminAuditLogs.id, rows.map((row) => row.id)));
    }
  });
});
