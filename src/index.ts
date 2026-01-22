import app from "./api/index.ts";
import { config } from "./config.ts";
import { startScheduler } from "./services/scheduler/index.ts";
import { logger } from "./logger.ts";
import { ensureCollection } from "./services/search/qdrant.ts";
import { startJobWorker } from "./services/jobs/worker.ts";

const port = config.PORT;

logger.info("Starting prediction market indexer", {
  port,
  database: config.DATABASE_URL.split("@")[1],
  qdrant: config.QDRANT_URL,
  autoSync: config.ENABLE_AUTO_SYNC,
});

// Warn if CORS is too permissive
if (config.CORS_ORIGINS === "*" || config.CORS_ORIGINS === "") {
  logger.warn("CORS configured to allow all origins - not recommended for production");
}

// Start the background sync scheduler
startScheduler();
startJobWorker();

// Warm up Qdrant collection to avoid cold-start errors
ensureCollection().catch((error) => {
  logger.warn("Failed to ensure Qdrant collection", {
    error: error instanceof Error ? error.message : String(error),
  });
});

export default {
  port,
  fetch: app.fetch,
  idleTimeout: 255, // Max allowed by Bun (4+ minutes)
};

// Also export types for library usage
export * from "./config.ts";
export * from "./types/market.ts";
export * from "./types/polymarket.ts";
export * from "./types/kalshi.ts";
