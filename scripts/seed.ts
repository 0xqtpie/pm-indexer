import { db, markets } from "../src/db/index.ts";
import { fetchPolymarketMarkets } from "../src/services/ingestion/polymarket.ts";
import { fetchKalshiMarkets } from "../src/services/ingestion/kalshi.ts";
import {
  normalizePolymarketMarket,
  normalizeKalshiMarket,
} from "../src/services/ingestion/normalizer.ts";
import {
  generateMarketEmbeddings,
  EMBEDDING_MODEL,
} from "../src/services/embedding/openai.ts";
import {
  ensureCollection,
  upsertMarkets,
  getCollectionInfo,
} from "../src/services/search/qdrant.ts";
import type { NormalizedMarket } from "../src/types/market.ts";
import type { NewMarket } from "../src/db/schema.ts";

async function main() {
  console.log("🌱 Starting seed process...\n");

  // Step 1: Fetch markets from APIs
  console.log("📊 Fetching markets from APIs...");
  const [polymarketRaw, kalshiRaw] = await Promise.all([
    fetchPolymarketMarkets({ limit: 200 }),
    fetchKalshiMarkets({ limit: 200 }),
  ]);
  console.log(`   Polymarket: ${polymarketRaw.length} markets`);
  console.log(`   Kalshi: ${kalshiRaw.length} markets`);

  // Step 2: Normalize markets
  console.log("\n🔄 Normalizing markets...");
  const normalizedMarkets: NormalizedMarket[] = [
    ...polymarketRaw.map(normalizePolymarketMarket),
    ...kalshiRaw.map(normalizeKalshiMarket),
  ];
  console.log(`   Total: ${normalizedMarkets.length} normalized markets`);

  // Step 3: Generate embeddings
  console.log("\n🧠 Generating embeddings (this may take a moment)...");
  const startEmbed = Date.now();
  const embeddings = await generateMarketEmbeddings(normalizedMarkets);
  const embedTime = ((Date.now() - startEmbed) / 1000).toFixed(1);
  console.log(`   Generated ${embeddings.size} embeddings in ${embedTime}s`);

  // Step 4: Ensure Qdrant collection exists
  console.log("\n📦 Setting up Qdrant collection...");
  await ensureCollection();

  // Step 5: Upsert to Qdrant
  console.log("\n⬆️  Upserting to Qdrant...");
  await upsertMarkets(normalizedMarkets, embeddings);
  const qdrantInfo = await getCollectionInfo();
  console.log(`   Qdrant vectors: ${qdrantInfo.vectorsCount}`);

  // Step 6: Save to Postgres
  console.log("\n💾 Saving to Postgres...");
  const dbRecords: NewMarket[] = normalizedMarkets.map((m) => ({
    id: m.id,
    sourceId: m.sourceId,
    source: m.source,
    title: m.title,
    description: m.description,
    rules: m.rules,
    category: m.category,
    tags: m.tags,
    yesPrice: m.yesPrice,
    noPrice: m.noPrice,
    lastPrice: m.lastPrice,
    volume: m.volume,
    volume24h: m.volume24h,
    liquidity: m.liquidity,
    status: m.status,
    result: m.result,
    createdAt: m.createdAt,
    openAt: m.openAt,
    closeAt: m.closeAt,
    expiresAt: m.expiresAt,
    url: m.url,
    imageUrl: m.imageUrl,
    embeddingModel: EMBEDDING_MODEL,
    lastSyncedAt: m.lastSyncedAt,
  }));

  // Use upsert-like behavior with onConflictDoUpdate
  for (const record of dbRecords) {
    await db
      .insert(markets)
      .values(record)
      .onConflictDoUpdate({
        target: markets.id,
        set: {
          title: record.title,
          description: record.description,
          yesPrice: record.yesPrice,
          noPrice: record.noPrice,
          volume: record.volume,
          volume24h: record.volume24h,
          status: record.status,
          lastSyncedAt: new Date(),
        },
      });
  }

  // Count records in Postgres
  const pgCount = await db.select().from(markets);
  console.log(`   Postgres records: ${pgCount.length}`);

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log("✅ SEED COMPLETE");
  console.log("=".repeat(50));
  console.log(`Markets fetched:    ${normalizedMarkets.length}`);
  console.log(`Embeddings created: ${embeddings.size}`);
  console.log(`Qdrant vectors:     ${qdrantInfo.vectorsCount}`);
  console.log(`Postgres records:   ${pgCount.length}`);
  console.log("=".repeat(50));

  // Verify success criteria
  if (qdrantInfo.vectorsCount >= 100 && pgCount.length >= 100) {
    console.log("\n✅ SUCCESS: 100+ vectors in Qdrant and 100+ records in Postgres!");
    process.exit(0);
  } else {
    console.log(
      `\n❌ FAILED: Need 100+ vectors/records (got ${qdrantInfo.vectorsCount}/${pgCount.length})`
    );
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
