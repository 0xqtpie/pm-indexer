import app from "./api/routes.ts";
import { config } from "./config.ts";
import { startScheduler } from "./services/scheduler/index.ts";

const port = config.PORT;

console.log(`🚀 Starting prediction market indexer...`);
console.log(`   Port: ${port}`);
console.log(`   Database: ${config.DATABASE_URL.split("@")[1]}`);
console.log(`   Qdrant: ${config.QDRANT_URL}`);
console.log(`   Auto-sync: ${config.ENABLE_AUTO_SYNC ? "enabled" : "disabled"}`);

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
