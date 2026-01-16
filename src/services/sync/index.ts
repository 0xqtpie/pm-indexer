import { db, markets } from "../../db/index.ts";
import { eq, and, inArray, sql } from "drizzle-orm";
import { fetchPolymarketMarkets } from "../ingestion/polymarket.ts";
import { fetchKalshiMarkets } from "../ingestion/kalshi.ts";
import {
  normalizePolymarketMarket,
  normalizeKalshiMarket,
} from "../ingestion/normalizer.ts";
import {
  generateMarketEmbeddings,
  EMBEDDING_MODEL,
} from "../embedding/openai.ts";
import { ensureCollection, upsertMarkets } from "../search/qdrant.ts";
import { config } from "../../config.ts";
import type { NormalizedMarket, MarketSource } from "../../types/market.ts";
import type { NewMarket, Market } from "../../db/schema.ts";
import { categorizeMarkets } from "./diff.ts";

export interface SyncResult {
  source: MarketSource;
  fetched: number;
  newMarkets: number;
  updatedPrices: number;
  contentChanged: number;
  embeddingsGenerated: number;
  errors: string[];
  durationMs: number;
}

export interface FullSyncResult {
  polymarket: SyncResult;
  kalshi: SyncResult;
  totalDurationMs: number;
}

/**
 * Sync state tracking
 */
let isSyncing = false;
let lastSyncTime: Date | null = null;
let lastFullSyncTime: Date | null = null;
let lastSyncResult: FullSyncResult | null = null;

export function getSyncStatus() {
  return {
    isSyncing,
    lastSyncTime,
    lastFullSyncTime,
    lastSyncResult,
  };
}

/**
 * Perform an incremental sync - only updates prices for existing markets
 * and generates embeddings for new or content-changed markets.
 */
export async function incrementalSync(): Promise<FullSyncResult> {
  if (isSyncing) {
    throw new Error("Sync already in progress");
  }

  isSyncing = true;
  const startTime = Date.now();

  try {
    console.log("🔄 Starting incremental sync...");

    // Ensure Qdrant collection exists
    await ensureCollection();

    // Sync both sources in parallel
    const [polymarketResult, kalshiResult] = await Promise.all([
      syncSource("polymarket", "open"),
      syncSource("kalshi", "open"),
    ]);

    const result: FullSyncResult = {
      polymarket: polymarketResult,
      kalshi: kalshiResult,
      totalDurationMs: Date.now() - startTime,
    };

    lastSyncTime = new Date();
    lastSyncResult = result;

    console.log(`✅ Incremental sync complete in ${result.totalDurationMs}ms`);
    console.log(
      `   Polymarket: ${polymarketResult.fetched} fetched, ${polymarketResult.newMarkets} new, ${polymarketResult.embeddingsGenerated} embeddings`
    );
    console.log(
      `   Kalshi: ${kalshiResult.fetched} fetched, ${kalshiResult.newMarkets} new, ${kalshiResult.embeddingsGenerated} embeddings`
    );

    return result;
  } finally {
    isSyncing = false;
  }
}

/**
 * Perform a full sync - fetches open, closed, and settled markets.
 */
export async function fullSync(): Promise<FullSyncResult> {
  if (isSyncing) {
    throw new Error("Sync already in progress");
  }

  isSyncing = true;
  const startTime = Date.now();

  try {
    console.log("🔄 Starting FULL sync (open + closed + settled markets)...");

    // Ensure Qdrant collection exists
    await ensureCollection();

    // Sync both sources
    const [polymarketResult, kalshiResult] = await Promise.all([
      syncSource("polymarket", "all"),
      syncSource("kalshi", "all"),
    ]);

    const result: FullSyncResult = {
      polymarket: polymarketResult,
      kalshi: kalshiResult,
      totalDurationMs: Date.now() - startTime,
    };

    lastSyncTime = new Date();
    lastFullSyncTime = new Date();
    lastSyncResult = result;

    console.log(`✅ Full sync complete in ${result.totalDurationMs}ms`);
    console.log(
      `   Polymarket: ${polymarketResult.fetched} fetched, ${polymarketResult.newMarkets} new`
    );
    console.log(
      `   Kalshi: ${kalshiResult.fetched} fetched, ${kalshiResult.newMarkets} new`
    );

    return result;
  } finally {
    isSyncing = false;
  }
}

async function syncSource(
  source: MarketSource,
  fetchStatus: "open" | "all"
): Promise<SyncResult> {
  const startTime = Date.now();
  const errors: string[] = [];
  const limit = config.MARKET_FETCH_LIMIT;
  const excludeSports = config.EXCLUDE_SPORTS;

  let fetched = 0;
  let newMarkets = 0;
  let updatedPrices = 0;
  let contentChanged = 0;
  let embeddingsGenerated = 0;

  try {
    // Step 1: Fetch open markets from API (sports excluded based on config)
    console.log(`📊 Fetching ${source} markets (limit: ${limit}, excludeSports: ${excludeSports})...`);

    let normalizedMarkets: NormalizedMarket[] = [];

    if (source === "polymarket") {
      const rawMarkets = await fetchPolymarketMarkets({
        limit,
        excludeSports,
        status: fetchStatus,
      });
      fetched = rawMarkets.length;
      normalizedMarkets = await Promise.all(
        rawMarkets.map(normalizePolymarketMarket)
      );
    } else {
      const rawMarkets = await fetchKalshiMarkets({
        limit,
        excludeSports,
        status: fetchStatus,
      });
      fetched = rawMarkets.length;
      normalizedMarkets = await Promise.all(
        rawMarkets.map(normalizeKalshiMarket)
      );
    }

    console.log(`   Fetched ${fetched} markets from ${source}`);

    // Step 2: Get existing markets from database by sourceId (batched to avoid param limit)
    const sourceIds = normalizedMarkets.map((m) => m.sourceId);
    const existingBySourceId = new Map<string, Market>();

    // Batch queries to avoid MAX_PARAMETERS_EXCEEDED (Postgres limit ~65k)
    const DB_BATCH_SIZE = 5000;
    for (let i = 0; i < sourceIds.length; i += DB_BATCH_SIZE) {
      const batchIds = sourceIds.slice(i, i + DB_BATCH_SIZE);
      const batchResults = await db
        .select()
        .from(markets)
        .where(
          and(eq(markets.source, source), inArray(markets.sourceId, batchIds))
        );
      for (const market of batchResults) {
        existingBySourceId.set(market.sourceId, market);
      }
    }

    console.log(`   Found ${existingBySourceId.size} existing markets in DB`);

    // Step 3: Categorize markets
    const {
      marketsToInsert,
      marketsToUpdatePrices,
      marketsNeedingEmbeddings,
      newMarkets: newMarketsCount,
      updatedPrices: updatedPricesCount,
      contentChanged: contentChangedCount,
    } = categorizeMarkets(normalizedMarkets, existingBySourceId);

    newMarkets = newMarketsCount;
    updatedPrices = updatedPricesCount;
    contentChanged = contentChangedCount;

    console.log(
      `   ${source}: ${marketsToInsert.length} new, ${updatedPrices} price updates, ${contentChanged} content changes`
    );

    // Step 4: Generate embeddings for new/changed markets
    if (marketsNeedingEmbeddings.length > 0) {
      console.log(
        `🧠 Generating embeddings for ${marketsNeedingEmbeddings.length} ${source} markets...`
      );
      const embeddings = await generateMarketEmbeddings(marketsNeedingEmbeddings);
      embeddingsGenerated = embeddings.size;

      // Upsert to Qdrant
      await upsertMarkets(marketsNeedingEmbeddings, embeddings);
      console.log(`   Upserted ${embeddings.size} vectors to Qdrant`);
    }

    // Step 5: Batch insert new markets to Postgres
    if (marketsToInsert.length > 0) {
      const BATCH_SIZE = 100;
      for (let i = 0; i < marketsToInsert.length; i += BATCH_SIZE) {
        const batch = marketsToInsert.slice(i, i + BATCH_SIZE);
        const dbRecords: NewMarket[] = batch.map((m) => ({
          id: m.id,
          sourceId: m.sourceId,
          source: m.source,
          title: m.title,
          subtitle: m.subtitle,
          description: m.description,
          rules: m.rules,
          category: m.category,
          tags: m.tags,
          contentHash: m.contentHash,
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

        await db.insert(markets).values(dbRecords);
      }
      console.log(`   Inserted ${marketsToInsert.length} new markets to Postgres`);
    }

    // Step 6: Batch update prices for existing markets
    if (marketsToUpdatePrices.length > 0) {
      // Use raw SQL for efficient batch update
      for (const update of marketsToUpdatePrices) {
        await db
          .update(markets)
          .set({
            yesPrice: update.yesPrice,
            noPrice: update.noPrice,
            volume: update.volume,
            volume24h: update.volume24h,
          status: update.status,
            lastSyncedAt: new Date(),
          })
          .where(eq(markets.id, update.id));
      }
    }

    // Step 7: Update content for changed markets
    for (const market of marketsNeedingEmbeddings) {
      if (existingBySourceId.has(market.sourceId)) {
        await db
          .update(markets)
          .set({
            title: market.title,
            description: market.description,
            rules: market.rules,
            contentHash: market.contentHash,
            embeddingModel: EMBEDDING_MODEL,
            lastSyncedAt: new Date(),
          })
          .where(eq(markets.id, market.id));
      }
    }
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    errors.push(errMsg);
    console.error(`❌ Error syncing ${source}:`, errMsg);
  }

  return {
    source,
    fetched,
    newMarkets,
    updatedPrices,
    contentChanged,
    embeddingsGenerated,
    errors,
    durationMs: Date.now() - startTime,
  };
}
