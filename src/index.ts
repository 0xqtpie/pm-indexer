import app from "./api/routes.ts";
import { config } from "./config.ts";
import { startScheduler } from "./services/scheduler/index.ts";
import { logger } from "./logger.ts";

const port = config.PORT;

logger.info("Starting prediction market indexer", {
  port,
  database: config.DATABASE_URL.split("@")[1],
  qdrant: config.QDRANT_URL,
  autoSync: config.ENABLE_AUTO_SYNC,
});

// Start the background sync scheduler
startScheduler();

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
