import { Hono } from "hono";
import { getSyncStatus, SyncRunError } from "../../services/sync/index.ts";
import {
  triggerIncrementalSync,
  triggerFullSync,
  isSchedulerRunning,
} from "../../services/scheduler/index.ts";
import { config } from "../../config.ts";
import { logger } from "../../logger.ts";
import { errorResponse } from "../utils.ts";
import { logAdminAction } from "../middleware.ts";

const router = new Hono();

function formatSyncResponse(result: Awaited<ReturnType<typeof triggerIncrementalSync>>) {
  return {
    status: result.status,
    success: result.status === "success",
    synced: {
      polymarket: {
        fetched: result.polymarket.fetched,
        new: result.polymarket.newMarkets,
        priceUpdates: result.polymarket.updatedPrices,
        contentChanged: result.polymarket.contentChanged,
        embeddings: result.polymarket.embeddingsGenerated,
        errors: result.polymarket.errors,
      },
      kalshi: {
        fetched: result.kalshi.fetched,
        new: result.kalshi.newMarkets,
        priceUpdates: result.kalshi.updatedPrices,
        contentChanged: result.kalshi.contentChanged,
        embeddings: result.kalshi.embeddingsGenerated,
        errors: result.kalshi.errors,
      },
      total: result.polymarket.fetched + result.kalshi.fetched,
    },
    durationMs: result.totalDurationMs,
  };
}

// Get sync status
router.get("/sync/status", async (c) => {
  const status = await getSyncStatus();
  return c.json({
    ...status,
    schedulerRunning: isSchedulerRunning(),
    config: {
      syncIntervalMinutes: config.SYNC_INTERVAL_MINUTES,
      fullSyncHour: config.FULL_SYNC_HOUR,
      marketFetchLimit: config.MARKET_FETCH_LIMIT,
      autoSyncEnabled: config.ENABLE_AUTO_SYNC,
    },
  });
});

// Trigger incremental sync (updates prices, only embeds new/changed markets)
router.post("/sync", async (c) => {
  const requestMeta = {
    ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
    userAgent: c.req.header("user-agent") ?? "unknown",
  };

  logger.info("Admin sync triggered (incremental)", requestMeta);

  try {
    const result = await triggerIncrementalSync();

    await logAdminAction(c, "sync.incremental", "success", {
      status: result.status,
    });

    return c.json({
      type: "incremental",
      ...formatSyncResponse(result),
    });
  } catch (error) {
    logger.error("Sync error", {
      error: error instanceof Error ? error.message : String(error),
      ...requestMeta,
    });

    if (error instanceof SyncRunError) {
      await logAdminAction(c, "sync.incremental", "failure", {
        status: error.status,
        errors: error.errors,
      });
      const httpStatus = error.status === "partial" ? 207 : 500;
      return c.json(
        {
          type: "incremental",
          ...formatSyncResponse(error.result),
        },
        httpStatus
      );
    }

    await logAdminAction(c, "sync.incremental", "failure", {
      error: error instanceof Error ? error.message : String(error),
    });

    const message = error instanceof Error ? error.message : "Sync failed";
    if (message.includes("Sync already in progress")) {
      return errorResponse(c, 409, "SYNC_IN_PROGRESS", message);
    }
    return errorResponse(c, 500, "INTERNAL_ERROR", message);
  }
});

// Trigger full sync (includes closed markets, updates status)
router.post("/sync/full", async (c) => {
  const requestMeta = {
    ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
    userAgent: c.req.header("user-agent") ?? "unknown",
  };

  logger.info("Admin sync triggered (full)", requestMeta);

  try {
    const result = await triggerFullSync();

    await logAdminAction(c, "sync.full", "success", {
      status: result.status,
    });

    return c.json({
      type: "full",
      ...formatSyncResponse(result),
    });
  } catch (error) {
    logger.error("Full sync error", {
      error: error instanceof Error ? error.message : String(error),
      ...requestMeta,
    });

    if (error instanceof SyncRunError) {
      await logAdminAction(c, "sync.full", "failure", {
        status: error.status,
        errors: error.errors,
      });
      const httpStatus = error.status === "partial" ? 207 : 500;
      return c.json(
        {
          type: "full",
          ...formatSyncResponse(error.result),
        },
        httpStatus
      );
    }

    await logAdminAction(c, "sync.full", "failure", {
      error: error instanceof Error ? error.message : String(error),
    });

    const message = error instanceof Error ? error.message : "Full sync failed";
    if (message.includes("Sync already in progress")) {
      return errorResponse(c, 409, "SYNC_IN_PROGRESS", message);
    }
    return errorResponse(c, 500, "INTERNAL_ERROR", message);
  }
});

export default router;
