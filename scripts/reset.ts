import { db, markets } from "../src/db/index.ts";
import { sql } from "drizzle-orm";
import { qdrant, COLLECTION_NAME } from "../src/services/search/qdrant.ts";

async function main() {
  console.log("🗑️  Resetting database...\n");

  // Step 1: Clear Postgres
  console.log("📦 Clearing Postgres markets table...");
  const deleted = await db.delete(markets);
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
