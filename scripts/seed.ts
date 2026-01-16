import { fullSync } from "../src/services/sync/index.ts";
import { ensureCollection } from "../src/services/search/qdrant.ts";
import { config } from "../src/config.ts";

async function main() {
  console.log("🌱 Starting seed process...");
  console.log(`   Market fetch limit: ${config.MARKET_FETCH_LIMIT}\n`);

  // Ensure Qdrant collection exists
  await ensureCollection();

  // Run a full sync (includes closed markets)
  const result = await fullSync();

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("✅ SEED COMPLETE");
  console.log("=".repeat(50));
  console.log(`Polymarket: ${result.polymarket.fetched} fetched, ${result.polymarket.newMarkets} new`);
  console.log(`Kalshi:     ${result.kalshi.fetched} fetched, ${result.kalshi.newMarkets} new`);
  console.log(`Embeddings: ${result.polymarket.embeddingsGenerated + result.kalshi.embeddingsGenerated}`);
  console.log(`Duration:   ${(result.totalDurationMs / 1000).toFixed(1)}s`);
  console.log("=".repeat(50));

  process.exit(0);
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
