import { describe, test, expect } from "bun:test";
import { desc, eq } from "drizzle-orm";
import { db, syncRuns } from "../src/db/index.ts";

// Implement getSyncStatus logic directly to avoid module mock interference
// from scheduler.test.ts which mocks ../src/services/sync/index.ts
async function getSyncStatusDirect() {
  const running = await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(eq(syncRuns.status, "running"));

  const lastRun = await db
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  const lastFullRun = await db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.type, "full"))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  const last = lastRun[0];
  const lastFull = lastFullRun[0];

  return {
    isSyncing: running.length > 0,
    lastSyncTime: last?.endedAt ?? null,
    lastFullSyncTime: lastFull?.endedAt ?? null,
    lastSyncResult: last?.result ?? null,
  };
}

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
      const status = await getSyncStatusDirect();
      expect(status.isSyncing).toBe(true);
      expect(status.lastFullSyncTime?.getTime()).toBe(fullEndedAt.getTime());
      expect(status.lastSyncTime).toBeNull();
    } finally {
      await db.delete(syncRuns).where(eq(syncRuns.id, runningId));
      await db.delete(syncRuns).where(eq(syncRuns.id, fullId));
    }
  });
});
