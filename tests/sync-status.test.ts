import { describe, test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { db, syncRuns } from "../src/db/index.ts";
import { getSyncStatus } from "../src/services/sync/index.ts";

describe("sync status durability", () => {
  test("reflects running and last full sync runs from storage", async () => {
    const runningId = crypto.randomUUID();
    const fullId = crypto.randomUUID();
    const now = Date.now();
    const futureBase = now + 24 * 60 * 60 * 1000;

    const fullStartedAt = new Date(futureBase);
    const fullEndedAt = new Date(futureBase + 5 * 60 * 1000);
    const runningStartedAt = new Date(futureBase + 60 * 60 * 1000);

    await db.insert(syncRuns).values({
      id: fullId,
      type: "full",
      status: "success",
      startedAt: fullStartedAt,
      endedAt: fullEndedAt,
      durationMs: 300000,
      result: { status: "success" },
      errors: [],
    });

    await db.insert(syncRuns).values({
      id: runningId,
      type: "incremental",
      status: "running",
      startedAt: runningStartedAt,
    });

    try {
      const status = await getSyncStatus();
      expect(status.isSyncing).toBe(true);
      expect(status.lastFullSyncTime?.getTime()).toBe(fullEndedAt.getTime());
      expect(status.lastSyncTime).toBeNull();
    } finally {
      await db.delete(syncRuns).where(eq(syncRuns.id, runningId));
      await db.delete(syncRuns).where(eq(syncRuns.id, fullId));
    }
  });
});
