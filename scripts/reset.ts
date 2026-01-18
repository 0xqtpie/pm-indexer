import {
  db,
  markets,
  marketPriceHistory,
  watchlists,
  watchlistItems,
  alerts,
  alertEvents,
  syncRuns,
  jobs,
  adminAuditLogs,
} from "../src/db/index.ts";
import { qdrant, COLLECTION_NAME } from "../src/services/search/qdrant.ts";

async function main() {
  console.log("🗑️  Resetting database...\n");

  // Step 1: Clear Postgres tables
  console.log("📦 Clearing Postgres tables...");
  await db.delete(alertEvents);
  await db.delete(alerts);
  await db.delete(watchlistItems);
  await db.delete(watchlists);
  await db.delete(marketPriceHistory);
  await db.delete(jobs);
  await db.delete(adminAuditLogs);
  await db.delete(syncRuns);
  await db.delete(markets);
  console.log("   Done");

  // Step 2: Delete Qdrant collection
  console.log("📦 Deleting Qdrant collection...");
  try {
    await qdrant.deleteCollection(COLLECTION_NAME);
    console.log(`   Deleted collection: ${COLLECTION_NAME}`);
  } catch (error) {
    console.log("   Collection doesn't exist or already deleted");
  }

  console.log("\n✅ Database reset complete!");
  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
