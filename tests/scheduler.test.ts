import { describe, test, expect, mock } from "bun:test";

let incrementalCalls = 0;
let fullCalls = 0;
let syncStatus = {
  isSyncing: false,
  lastSyncTime: null as Date | null,
  lastFullSyncTime: null as Date | null,
  lastSyncResult: null as null | Record<string, unknown>,
};

function mockResult() {
  return {
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
    status: "success" as const,
  };
}

mock.module("../src/services/sync/index.ts", () => ({
  incrementalSync: async () => {
    incrementalCalls += 1;
    return mockResult();
  },
  fullSync: async () => {
    fullCalls += 1;
    return mockResult();
  },
  getSyncStatus: async () => syncStatus,
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
      incrementalCalls = 0;
      fullCalls = 0;
      syncStatus = {
        isSyncing: false,
        lastSyncTime: null,
        lastFullSyncTime: null,
        lastSyncResult: null,
      };

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

  test("schedules incremental and full syncs based on timing and status", async () => {
    const { config } = await import("../src/config.ts");
    const {
      startScheduler,
      stopScheduler,
      isSchedulerRunning,
    } = await import("../src/services/scheduler/index.ts");

    const originalAutoSync = config.ENABLE_AUTO_SYNC;
    const originalInterval = config.SYNC_INTERVAL_MINUTES;
    const originalFullHour = config.FULL_SYNC_HOUR;
    const originalSetInterval = globalThis.setInterval;
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearInterval = globalThis.clearInterval;
    const realDate = Date;

    const intervals: Array<{ cb: () => Promise<void> | void; ms: number }> = [];
    const timeouts: Array<{ cb: () => Promise<void> | void; ms: number }> = [];

    globalThis.setInterval = ((cb, ms) => {
      intervals.push({ cb: cb as () => Promise<void> | void, ms: ms as number });
      return intervals.length;
    }) as typeof setInterval;
    globalThis.setTimeout = ((cb, ms) => {
      timeouts.push({ cb: cb as () => Promise<void> | void, ms: ms as number });
      return timeouts.length;
    }) as typeof setTimeout;
    globalThis.clearInterval = (() => {}) as typeof clearInterval;

    let fakeNow = new realDate("2024-01-02T03:05:00").getTime();
    class MockDate extends realDate {
      constructor(...args: ConstructorParameters<typeof realDate>) {
        if (args.length === 0) {
          super(fakeNow);
        } else {
          super(...args);
        }
      }
      static now() {
        return fakeNow;
      }
      static parse = realDate.parse;
      static UTC = realDate.UTC;
    }
    globalThis.Date = MockDate as typeof Date;

    try {
      incrementalCalls = 0;
      fullCalls = 0;
      syncStatus = {
        isSyncing: false,
        lastSyncTime: null,
        lastFullSyncTime: null,
        lastSyncResult: null,
      };

      config.ENABLE_AUTO_SYNC = true;
      config.SYNC_INTERVAL_MINUTES = 5;
      config.FULL_SYNC_HOUR = 3;

      startScheduler();
      expect(isSchedulerRunning()).toBe(true);

      const incrementInterval = intervals.find(
        (entry) => entry.ms === config.SYNC_INTERVAL_MINUTES * 60 * 1000
      );
      const fullInterval = intervals.find((entry) => entry.ms === 60 * 1000);
      const initialTimeout = timeouts.find((entry) => entry.ms === 5000);

      expect(incrementInterval).toBeTruthy();
      expect(fullInterval).toBeTruthy();
      expect(initialTimeout).toBeTruthy();

      await initialTimeout?.cb();
      expect(incrementalCalls).toBe(1);

      await incrementInterval?.cb();
      expect(incrementalCalls).toBe(2);

      syncStatus.isSyncing = true;
      await incrementInterval?.cb();
      expect(incrementalCalls).toBe(2);

      syncStatus.isSyncing = false;
      await fullInterval?.cb();
      expect(fullCalls).toBe(1);

      syncStatus.lastFullSyncTime = new Date(fakeNow);
      await fullInterval?.cb();
      expect(fullCalls).toBe(1);

      syncStatus.isSyncing = true;
      fakeNow = new realDate("2024-01-03T03:05:00").getTime();
      syncStatus.lastFullSyncTime = new Date(fakeNow - 24 * 60 * 60 * 1000);
      await fullInterval?.cb();
      expect(fullCalls).toBe(1);

      syncStatus.isSyncing = false;
      await fullInterval?.cb();
      expect(fullCalls).toBe(2);
    } finally {
      stopScheduler();
      config.ENABLE_AUTO_SYNC = originalAutoSync;
      config.SYNC_INTERVAL_MINUTES = originalInterval;
      config.FULL_SYNC_HOUR = originalFullHour;
      globalThis.setInterval = originalSetInterval;
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearInterval = originalClearInterval;
      globalThis.Date = realDate;
    }
  });
});
