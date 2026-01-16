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
import {
  ensureCollection,
  upsertMarkets,
  updateMarketPayloads,
} from "../search/qdrant.ts";
import { config } from "../../config.ts";
import type { NormalizedMarket, MarketSource } from "../../types/market.ts";
import type { NewMarket } from "../../db/schema.ts";
import { categorizeMarkets } from "./diff.ts";
import type { ExistingMarket } from "./diff.ts";
import { logger } from "../../logger.ts";
import { recordSyncFailure, recordSyncSuccess } from "../../metrics.ts";

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
    logger.info("Starting incremental sync");

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

    logger.info("Incremental sync complete", {
      durationMs: result.totalDurationMs,
      polymarket: {
        fetched: polymarketResult.fetched,
        newMarkets: polymarketResult.newMarkets,
        embeddingsGenerated: polymarketResult.embeddingsGenerated,
      },
      kalshi: {
        fetched: kalshiResult.fetched,
        newMarkets: kalshiResult.newMarkets,
        embeddingsGenerated: kalshiResult.embeddingsGenerated,
      },
    });

    recordSyncSuccess("incremental", result.totalDurationMs);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordSyncFailure("incremental", message);
    throw error;
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
    logger.info("Starting full sync", { scope: "open, closed, settled" });

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

    logger.info("Full sync complete", {
      durationMs: result.totalDurationMs,
      polymarket: {
        fetched: polymarketResult.fetched,
        newMarkets: polymarketResult.newMarkets,
      },
      kalshi: {
        fetched: kalshiResult.fetched,
        newMarkets: kalshiResult.newMarkets,
      },
    });

    recordSyncSuccess("full", result.totalDurationMs);
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordSyncFailure("full", message);
    throw error;
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
    logger.info("Fetching markets", {
      source,
      limit,
      excludeSports,
      status: fetchStatus,
    });

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

    logger.info("Fetched markets", { source, fetched });

    // Step 2: Get existing markets from database by sourceId (batched to avoid param limit)
    const sourceIds = normalizedMarkets.map((m) => m.sourceId);
    const existingBySourceId = new Map<string, ExistingMarket>();

    // Batch queries to avoid MAX_PARAMETERS_EXCEEDED (Postgres limit ~65k)
    const DB_BATCH_SIZE = 5000;
    for (let i = 0; i < sourceIds.length; i += DB_BATCH_SIZE) {
      const batchIds = sourceIds.slice(i, i + DB_BATCH_SIZE);
      const batchResults = await db
        .select({
          id: markets.id,
          sourceId: markets.sourceId,
          contentHash: markets.contentHash,
        })
        .from(markets)
        .where(
          and(eq(markets.source, source), inArray(markets.sourceId, batchIds))
        );
      for (const market of batchResults) {
        existingBySourceId.set(market.sourceId, market);
      }
    }

    logger.info("Loaded existing markets", {
      source,
      count: existingBySourceId.size,
    });

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

    logger.info("Categorized markets", {
      source,
      newMarkets: marketsToInsert.length,
      priceUpdates: updatedPrices,
      contentChanged,
    });

    // Step 4: Generate embeddings for new/changed markets
    if (marketsNeedingEmbeddings.length > 0) {
      logger.info("Generating embeddings", {
        source,
        count: marketsNeedingEmbeddings.length,
      });
      const embeddings = await generateMarketEmbeddings(marketsNeedingEmbeddings);
      embeddingsGenerated = embeddings.size;

      // Upsert to Qdrant
      await upsertMarkets(marketsNeedingEmbeddings, embeddings);
      logger.info("Upserted vectors to Qdrant", {
        source,
        vectors: embeddings.size,
      });
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
      logger.info("Inserted new markets", {
        source,
        count: marketsToInsert.length,
      });
    }

    // Step 6: Batch update prices for existing markets
    if (marketsToUpdatePrices.length > 0) {
      const updateStart = Date.now();
      const syncedAt = new Date();

      const updates = marketsToUpdatePrices.map(
        (update) =>
          sql`(${update.id}, ${update.yesPrice}, ${update.noPrice}, ${update.volume}, ${update.volume24h}, ${update.status}, ${syncedAt})`
      );

      await db.execute(sql`
        UPDATE ${markets} AS m
        SET
          yes_price = v.yes_price,
          no_price = v.no_price,
          volume = v.volume,
          volume_24h = v.volume_24h,
          status = v.status::market_status,
          last_synced_at = v.last_synced_at
        FROM (VALUES ${sql.join(updates, sql`, `)})
          AS v(id, yes_price, no_price, volume, volume_24h, status, last_synced_at)
        WHERE m.id = v.id
      `);

      logger.info("Batch updated markets", {
        source,
        count: marketsToUpdatePrices.length,
        durationMs: Date.now() - updateStart,
      });
    }

    // Step 7: Refresh payloads for existing markets (price/status changes)
    if (marketsToUpdatePrices.length > 0) {
      const embeddingIds = new Set(
        marketsNeedingEmbeddings.map((market) => market.id)
      );
      const payloadRefreshMarkets = normalizedMarkets.filter(
        (market) =>
          existingBySourceId.has(market.sourceId) &&
          !embeddingIds.has(market.id)
      );

      await updateMarketPayloads(payloadRefreshMarkets);
    }

    // Step 8: Update content for changed markets
    for (const market of marketsNeedingEmbeddings) {
      if (existingBySourceId.has(market.sourceId)) {
        await db
          .update(markets)
          .set({
            title: market.title,
            subtitle: market.subtitle,
            description: market.description,
            rules: market.rules,
            category: market.category,
            tags: market.tags,
            closeAt: market.closeAt,
            url: market.url,
            imageUrl: market.imageUrl,
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
    logger.error("Error syncing source", { source, error: errMsg });
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
