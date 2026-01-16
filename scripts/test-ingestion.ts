import { fetchPolymarketMarkets } from "../src/services/ingestion/polymarket.ts";
import { fetchKalshiMarkets } from "../src/services/ingestion/kalshi.ts";
import {
  normalizePolymarketMarket,
  normalizeKalshiMarket,
} from "../src/services/ingestion/normalizer.ts";

async function main() {
  console.log("🔄 Testing ingestion from prediction market APIs...\n");

  // Fetch from Polymarket
  console.log("📊 Fetching Polymarket markets...");
  const polymarketStart = Date.now();
  const polymarketRaw = await fetchPolymarketMarkets({ limit: 100 });
  const polymarketTime = Date.now() - polymarketStart;
  console.log(
    `   ✓ Fetched ${polymarketRaw.length} markets in ${polymarketTime}ms`
  );

  // Fetch from Kalshi
  console.log("📊 Fetching Kalshi markets...");
  const kalshiStart = Date.now();
  const kalshiRaw = await fetchKalshiMarkets({ limit: 100 });
  const kalshiTime = Date.now() - kalshiStart;
  console.log(`   ✓ Fetched ${kalshiRaw.length} markets in ${kalshiTime}ms`);

  // Normalize
  console.log("\n🔄 Normalizing markets...");
  const polymarketNormalized = await Promise.all(
    polymarketRaw.map(normalizePolymarketMarket)
  );
  const kalshiNormalized = await Promise.all(
    kalshiRaw.map(normalizeKalshiMarket)
  );

  const totalNormalized =
    polymarketNormalized.length + kalshiNormalized.length;
  console.log(`   ✓ Normalized ${totalNormalized} markets total`);

  // Show samples
  console.log("\n📋 Sample Polymarket market:");
  if (polymarketNormalized[0]) {
    const sample = polymarketNormalized[0];
    console.log(`   Title: ${sample.title}`);
    console.log(`   Yes Price: ${(sample.yesPrice * 100).toFixed(1)}%`);
    console.log(`   Volume: $${sample.volume.toLocaleString()}`);
    console.log(`   URL: ${sample.url}`);
  }

  console.log("\n📋 Sample Kalshi market:");
  if (kalshiNormalized[0]) {
    const sample = kalshiNormalized[0];
    console.log(`   Title: ${sample.title}`);
    console.log(`   Yes Price: ${(sample.yesPrice * 100).toFixed(1)}%`);
    console.log(`   Volume: ${sample.volume.toLocaleString()} contracts`);
    console.log(`   URL: ${sample.url}`);
  }

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("📈 SUMMARY");
  console.log("=".repeat(50));
  console.log(`Polymarket: ${polymarketNormalized.length} markets`);
  console.log(`Kalshi:     ${kalshiNormalized.length} markets`);
  console.log(`Total:      ${totalNormalized} markets`);
  console.log("=".repeat(50));

  // Success check
  if (totalNormalized >= 50) {
    console.log("\n✅ SUCCESS: Fetched and normalized 50+ markets!");
    process.exit(0);
  } else {
    console.log(
      `\n❌ FAILED: Only fetched ${totalNormalized} markets (need 50+)`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
