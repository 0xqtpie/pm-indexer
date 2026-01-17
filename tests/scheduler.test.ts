import { describe, test, expect, mock } from "bun:test";

mock.module("../src/services/sync/index.ts", () => ({
  incrementalSync: async () => ({
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
  }),
  fullSync: async () => ({
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
  }),
  getSyncStatus: async () => ({
    isSyncing: false,
    lastSyncTime: null,
    lastFullSyncTime: null,
    lastSyncResult: null,
  }),
}));

describe("sync scheduler", () => {
  test("respects ENABLE_AUTO_SYNC and toggles running state", async () => {
    const { config } = await import("../src/config.ts");
    const {
      startScheduler,
      stopScheduler,
      isSchedulerRunning,
    } = await import("../src/services/scheduler/index.ts");

    const originalAutoSync = config.ENABLE_AUTO_SYNC;
    const originalSetInterval = globalThis.setInterval;
    const originalSetTimeout = globalThis.setTimeout;

    globalThis.setInterval = (() => 0) as typeof setInterval;
    globalThis.setTimeout = (() => 0) as typeof setTimeout;

    try {
      config.ENABLE_AUTO_SYNC = false;
      startScheduler();
      expect(isSchedulerRunning()).toBe(false);

      config.ENABLE_AUTO_SYNC = true;
      startScheduler();
      expect(isSchedulerRunning()).toBe(true);
      stopScheduler();
      expect(isSchedulerRunning()).toBe(false);
    } finally {
      stopScheduler();
      config.ENABLE_AUTO_SYNC = originalAutoSync;
      globalThis.setInterval = originalSetInterval;
      globalThis.setTimeout = originalSetTimeout;
    }
  });
});
