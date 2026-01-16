import { config } from "../../config.ts";
import { incrementalSync, fullSync, getSyncStatus } from "../sync/index.ts";
import { logger } from "../../logger.ts";

let incrementalIntervalId: ReturnType<typeof setInterval> | null = null;
let fullSyncCheckIntervalId: ReturnType<typeof setInterval> | null = null;
let isRunning = false;

/**
 * Start the background sync scheduler.
 *
 * - Incremental sync runs every SYNC_INTERVAL_MINUTES (default: 30)
 * - Full sync runs once daily at FULL_SYNC_HOUR (default: 3 AM)
 */
export function startScheduler(): void {
  if (isRunning) {
    logger.warn("Scheduler already running");
    return;
  }

  if (!config.ENABLE_AUTO_SYNC) {
    logger.info("Auto-sync disabled", { enableAutoSync: config.ENABLE_AUTO_SYNC });
    return;
  }

  isRunning = true;
  const intervalMs = config.SYNC_INTERVAL_MINUTES * 60 * 1000;

  logger.info("Starting sync scheduler", {
    incrementalIntervalMinutes: config.SYNC_INTERVAL_MINUTES,
    fullSyncHour: config.FULL_SYNC_HOUR,
  });

  // Start incremental sync interval
  incrementalIntervalId = setInterval(async () => {
    try {
      await runIncrementalSync();
    } catch (error) {
      logger.error("Scheduled incremental sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, intervalMs);

  // Check every minute if it's time for full sync
  fullSyncCheckIntervalId = setInterval(async () => {
    const now = new Date();
    const { lastFullSyncTime, isSyncing } = getSyncStatus();

    // Check if it's the right hour and we haven't done a full sync today
    if (now.getHours() === config.FULL_SYNC_HOUR && !isSyncing) {
      const today = now.toDateString();
      const lastFullSyncDay = lastFullSyncTime?.toDateString();

      if (lastFullSyncDay !== today) {
        logger.info("Time for daily full sync");
        try {
          await runFullSync();
        } catch (error) {
          logger.error("Scheduled full sync failed", {
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
  }, 60 * 1000); // Check every minute

  // Run initial sync after a short delay
  setTimeout(async () => {
    logger.info("Running initial sync");
    try {
      await runIncrementalSync();
    } catch (error) {
      logger.error("Initial sync failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, 5000);
}

/**
 * Stop the background sync scheduler.
 */
export function stopScheduler(): void {
  if (incrementalIntervalId) {
    clearInterval(incrementalIntervalId);
    incrementalIntervalId = null;
  }

  if (fullSyncCheckIntervalId) {
    clearInterval(fullSyncCheckIntervalId);
    fullSyncCheckIntervalId = null;
  }

  isRunning = false;
  logger.info("Sync scheduler stopped");
}

/**
 * Check if the scheduler is running.
 */
export function isSchedulerRunning(): boolean {
  return isRunning;
}

/**
 * Run an incremental sync with error handling.
 */
async function runIncrementalSync(): Promise<void> {
  const { isSyncing } = getSyncStatus();

  if (isSyncing) {
    logger.info("Skipping incremental sync - sync already in progress");
    return;
  }

  await incrementalSync();
}

/**
 * Run a full sync with error handling.
 */
async function runFullSync(): Promise<void> {
  const { isSyncing } = getSyncStatus();

  if (isSyncing) {
    logger.info("Skipping full sync - sync already in progress");
    return;
  }

  await fullSync();
}

/**
 * Manually trigger an incremental sync.
 */
export async function triggerIncrementalSync() {
  return incrementalSync();
}

/**
 * Manually trigger a full sync.
 */
export async function triggerFullSync() {
  return fullSync();
}
