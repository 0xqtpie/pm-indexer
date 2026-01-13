import app from "./api/routes.ts";
import { config } from "./config.ts";

const port = config.PORT;

console.log(`🚀 Starting prediction market indexer...`);
console.log(`   Port: ${port}`);
console.log(`   Database: ${config.DATABASE_URL.split("@")[1]}`);
console.log(`   Qdrant: ${config.QDRANT_URL}`);

export default {
  port,
  fetch: app.fetch,
};

// Also export types for library usage
export * from "./config.ts";
export * from "./types/market.ts";
export * from "./types/polymarket.ts";
export * from "./types/kalshi.ts";
