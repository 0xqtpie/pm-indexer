const MARKET_FETCH_LIMIT = 50000;

// Set env vars BEFORE importing config
process.env.MARKET_FETCH_LIMIT = String(MARKET_FETCH_LIMIT);
process.env.EXCLUDE_SPORTS = "false";

const { fullSync } = await import("../src/services/sync/index.ts");

console.log("=".repeat(60));
console.log("SYNC BENCHMARK");
console.log("=".repeat(60));
console.log(`Market fetch limit: ${MARKET_FETCH_LIMIT}`);
console.log(`Started at: ${new Date().toISOString()}`);
console.log("");

const overallStart = performance.now();

try {
  const result = await fullSync();
  const overallEnd = performance.now();
  const totalMs = overallEnd - overallStart;

  console.log("");
  console.log("=".repeat(60));
  console.log("BENCHMARK RESULTS");
  console.log("=".repeat(60));
  console.log("");

  console.log("## Overall");
  console.log(`Total time: ${(totalMs / 1000).toFixed(2)}s`);
  console.log(`Status: ${result.status}`);
  console.log("");

  for (const [source, data] of Object.entries(result)) {
    if (source === 'totalDurationMs' || source === 'status') continue;
    const sourceData = data as any;

    console.log(`## ${source.charAt(0).toUpperCase() + source.slice(1)}`);
    console.log(`  Fetched: ${sourceData.fetched}`);
    console.log(`  New markets: ${sourceData.newMarkets}`);
    console.log(`  Updated prices: ${sourceData.updatedPrices}`);
    console.log(`  Content changed: ${sourceData.contentChanged}`);
    console.log(`  Embeddings generated: ${sourceData.embeddingsGenerated}`);
    console.log(`  Duration: ${(sourceData.durationMs / 1000).toFixed(2)}s`);
    console.log(`  Status: ${sourceData.status}`);
    if (sourceData.errors?.length > 0) {
      console.log(`  Errors: ${sourceData.errors.join(", ")}`);
    }
    console.log("");
  }

  // Calculate rates
  const totalFetched = (result.polymarket?.fetched || 0) + (result.kalshi?.fetched || 0);
  const totalNew = (result.polymarket?.newMarkets || 0) + (result.kalshi?.newMarkets || 0);
  const totalEmbeddings = (result.polymarket?.embeddingsGenerated || 0) + (result.kalshi?.embeddingsGenerated || 0);

  console.log("## Performance Metrics");
  console.log(`  Markets fetched: ${totalFetched}`);
  console.log(`  Markets inserted: ${totalNew}`);
  console.log(`  Embeddings generated: ${totalEmbeddings}`);
  console.log(`  Fetch rate: ${(totalFetched / (totalMs / 1000)).toFixed(1)} markets/s`);
  if (totalNew > 0) {
    console.log(`  Insert rate: ${(totalNew / (totalMs / 1000)).toFixed(1)} markets/s`);
  }
  if (totalEmbeddings > 0) {
    console.log(`  Embedding rate: ${(totalEmbeddings / (totalMs / 1000)).toFixed(1)} embeddings/s`);
    console.log(`  Est. embedding cost: $${(totalEmbeddings * 0.00001).toFixed(4)} (at ~$0.00001/embedding)`);
  }
  console.log("");
  console.log("Finished at:", new Date().toISOString());

  process.exit(0);
} catch (error) {
  console.error("Sync failed:", error);
  process.exit(1);
}
