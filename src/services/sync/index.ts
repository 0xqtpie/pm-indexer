import {
  db,
  markets,
  syncRuns,
  marketPriceHistory,
  alerts,
  alertEvents,
} from "../../db/index.ts";
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { streamPolymarketMarkets } from "../ingestion/polymarket.ts";
import { streamKalshiMarkets } from "../ingestion/kalshi.ts";
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
import type { ExistingMarket, MarketPriceUpdate } from "./diff.ts";
import { logger } from "../../logger.ts";
import {
  recordSyncFailure,
  recordSyncPartial,
  recordSyncSuccess,
} from "../../metrics.ts";
import { enqueueEmbeddingJob } from "../jobs/index.ts";

function buildUuidInCondition(
  column: typeof alerts.marketId,
  ids: string[]
) {
  if (ids.length === 0) return undefined;
  const values = ids.map((id) => sql`${id}::uuid`);
  return sql`${column} IN (${sql.join(values, sql`, `)})`;
}

export interface SyncResult {
  source: MarketSource;
  fetched: number;
  newMarkets: number;
  updatedPrices: number;
  contentChanged: number;
  embeddingsGenerated: number;
  errors: string[];
  durationMs: number;
  status: "success" | "failed";
}

export interface FullSyncResult {
  polymarket: SyncResult;
  kalshi: SyncResult;
  totalDurationMs: number;
  status: "success" | "partial" | "failed";
}

class SyncSourceError extends Error {
  source: MarketSource;
  result: SyncResult;

  constructor(source: MarketSource, message: string, result: SyncResult) {
    super(message);
    this.source = source;
    this.result = result;
    this.name = "SyncSourceError";
  }
}

class SyncRunError extends Error {
  status: "partial" | "failed";
  result: FullSyncResult;
  errors: string[];

  constructor(
    status: "partial" | "failed",
    message: string,
    result: FullSyncResult,
    errors: string[]
  ) {
    super(message);
    this.status = status;
    this.result = result;
    this.errors = errors;
    this.name = "SyncRunError";
  }
}

async function startSyncRun(type: "incremental" | "full"): Promise<string> {
  const rows = (await db.execute(sql`
    INSERT INTO ${syncRuns} (type, status, started_at)
    SELECT ${type}, 'running', NOW()
    WHERE NOT EXISTS (
      SELECT 1 FROM ${syncRuns} WHERE status = 'running'
    )
    RETURNING ${syncRuns.id} AS id
  `)) as Array<{ id: string }>;

  const runId = rows[0]?.id;
  if (!runId) {
    throw new Error("Sync already in progress");
  }

  return runId;
}

async function finishSyncRun(
  runId: string,
  status: "success" | "partial" | "failed",
  result: FullSyncResult,
  errors: string[]
): Promise<void> {
  await db
    .update(syncRuns)
    .set({
      status,
      endedAt: new Date(),
      durationMs: result.totalDurationMs,
      result,
      errors,
    })
    .where(eq(syncRuns.id, runId));
}

function buildFailedResult(source: MarketSource, error: string): SyncResult {
  return {
    source,
    fetched: 0,
    newMarkets: 0,
    updatedPrices: 0,
    contentChanged: 0,
    embeddingsGenerated: 0,
    errors: [error],
    durationMs: 0,
    status: "failed",
  };
}

function summarizeSyncResults(
  results: Array<
    PromiseSettledResult<SyncResult> & {
      value?: SyncResult;
      reason?: unknown;
    }
  >,
  startTime: number
): { result: FullSyncResult; status: "success" | "partial" | "failed"; errors: string[] } {
  const errors: string[] = [];

  const resolved: Record<MarketSource, SyncResult> = {
    polymarket: buildFailedResult("polymarket", "No result"),
    kalshi: buildFailedResult("kalshi", "No result"),
  };

  for (const outcome of results) {
    if (outcome.status === "fulfilled") {
      resolved[outcome.value.source] = outcome.value;
      continue;
    }

    const reason = outcome.reason;
    if (reason instanceof SyncSourceError) {
      resolved[reason.source] = reason.result;
      errors.push(...reason.result.errors);
      continue;
    }

    const message = reason instanceof Error ? reason.message : String(reason);
    errors.push(message);
  }

  const polymarketStatus = resolved.polymarket.status;
  const kalshiStatus = resolved.kalshi.status;

  let status: "success" | "partial" | "failed" = "success";
  if (polymarketStatus === "failed" && kalshiStatus === "failed") {
    status = "failed";
  } else if (polymarketStatus === "failed" || kalshiStatus === "failed") {
    status = "partial";
  }

  const result: FullSyncResult = {
    polymarket: {
      ...resolved.polymarket,
      durationMs: resolved.polymarket.durationMs || Date.now() - startTime,
    },
    kalshi: {
      ...resolved.kalshi,
      durationMs: resolved.kalshi.durationMs || Date.now() - startTime,
    },
    totalDurationMs: Date.now() - startTime,
    status,
  };

  return { result, status, errors };
}

/**
 * Sync state tracking (persisted in sync_runs).
 */
export async function getSyncStatus() {
  const running = (await db
    .select({ id: syncRuns.id })
    .from(syncRuns)
    .where(eq(syncRuns.status, "running"))) as Array<{ id: string }>;

  const lastRun = await db
    .select()
    .from(syncRuns)
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  const lastFullRun = await db
    .select()
    .from(syncRuns)
    .where(eq(syncRuns.type, "full"))
    .orderBy(desc(syncRuns.startedAt))
    .limit(1);

  const last = lastRun[0];
  const lastFull = lastFullRun[0];

  return {
    isSyncing: running.length > 0,
    lastSyncTime: last?.endedAt ?? null,
    lastFullSyncTime: lastFull?.endedAt ?? null,
    lastSyncResult: (last?.result as FullSyncResult | null) ?? null,
  };
}

/**
 * Perform an incremental sync - only updates prices for existing markets
 * and generates embeddings for new or content-changed markets.
 */
export async function incrementalSync(): Promise<FullSyncResult> {
  const runId = await startSyncRun("incremental");
  const startTime = Date.now();

  try {
    logger.info("Starting incremental sync");

    // Ensure Qdrant collection exists
    await ensureCollection();

    // Sync both sources in parallel
    const results = await Promise.allSettled([
      syncSource("polymarket", "open"),
      syncSource("kalshi", "open"),
    ]);

    const { result, status, errors } = summarizeSyncResults(results, startTime);

    await finishSyncRun(runId, status, result, errors);

    if (status === "success") {
      recordSyncSuccess("incremental", result.totalDurationMs);
    } else if (status === "partial") {
      recordSyncPartial(
        "incremental",
        errors.join("; "),
        result.totalDurationMs
      );
    } else {
      recordSyncFailure("incremental", errors.join("; "));
      throw new SyncRunError("failed", "Incremental sync failed", result, errors);
    }

    if (status === "partial") {
      throw new SyncRunError("partial", "Incremental sync partially failed", result, errors);
    }

    logger.info("Incremental sync complete", {
      durationMs: result.totalDurationMs,
      polymarket: {
        fetched: result.polymarket.fetched,
        newMarkets: result.polymarket.newMarkets,
        embeddingsGenerated: result.polymarket.embeddingsGenerated,
      },
      kalshi: {
        fetched: result.kalshi.fetched,
        newMarkets: result.kalshi.newMarkets,
        embeddingsGenerated: result.kalshi.embeddingsGenerated,
      },
    });

    return result;
  } catch (error) {
    if (!(error instanceof SyncRunError)) {
      const message = error instanceof Error ? error.message : String(error);
      recordSyncFailure("incremental", message);
    }
    throw error;
  }
}

/**
 * Perform a full sync - fetches open, closed, and settled markets.
 */
export async function fullSync(): Promise<FullSyncResult> {
  const runId = await startSyncRun("full");
  const startTime = Date.now();

  try {
    logger.info("Starting full sync", { scope: "open, closed, settled" });

    // Ensure Qdrant collection exists
    await ensureCollection();

    // Sync both sources
    const results = await Promise.allSettled([
      syncSource("polymarket", "all"),
      syncSource("kalshi", "all"),
    ]);

    const { result, status, errors } = summarizeSyncResults(results, startTime);

    await finishSyncRun(runId, status, result, errors);

    if (status === "success") {
      recordSyncSuccess("full", result.totalDurationMs);
    } else if (status === "partial") {
      recordSyncPartial("full", errors.join("; "), result.totalDurationMs);
    } else {
      recordSyncFailure("full", errors.join("; "));
      throw new SyncRunError("failed", "Full sync failed", result, errors);
    }

    if (status === "partial") {
      throw new SyncRunError("partial", "Full sync partially failed", result, errors);
    }

    logger.info("Full sync complete", {
      durationMs: result.totalDurationMs,
      polymarket: {
        fetched: result.polymarket.fetched,
        newMarkets: result.polymarket.newMarkets,
      },
      kalshi: {
        fetched: result.kalshi.fetched,
        newMarkets: result.kalshi.newMarkets,
      },
    });

    return result;
  } catch (error) {
    if (!(error instanceof SyncRunError)) {
      const message = error instanceof Error ? error.message : String(error);
      recordSyncFailure("full", message);
    }
    throw error;
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
    logger.info("Fetching markets", {
      source,
      limit,
      excludeSports,
      status: fetchStatus,
    });

    const seenSourceIds = new Set<string>();
    const stream =
      source === "polymarket"
        ? streamPolymarketMarkets({
            limit,
            excludeSports,
            status: fetchStatus,
          })
        : streamKalshiMarkets({
            limit,
            excludeSports,
            status: fetchStatus,
          });

    for await (const rawBatch of stream) {
      if (rawBatch.length === 0) continue;

      const uniqueBatch = rawBatch.filter((market) => {
        const sourceId = source === "polymarket" ? market.id : market.ticker;
        if (seenSourceIds.has(sourceId)) {
          return false;
        }
        seenSourceIds.add(sourceId);
        return true;
      });

      if (uniqueBatch.length === 0) continue;

      fetched += uniqueBatch.length;

      const normalizedMarkets: NormalizedMarket[] =
        source === "polymarket"
          ? await Promise.all(uniqueBatch.map(normalizePolymarketMarket))
          : await Promise.all(uniqueBatch.map(normalizeKalshiMarket));

      const sourceIds = Array.from(
        new Set(normalizedMarkets.map((m) => m.sourceId))
      );

      const existingBySourceId = await loadExistingMarkets(source, sourceIds);

      logger.info("Loaded existing markets", {
        source,
        count: existingBySourceId.size,
      });

      const categorized = categorizeMarkets(normalizedMarkets, existingBySourceId);

      newMarkets += categorized.newMarkets;
      updatedPrices += categorized.updatedPrices;
      contentChanged += categorized.contentChanged;

      const batchEmbeddings = await applyBatchChanges({
        source,
        normalizedMarkets,
        existingBySourceId,
        marketsToInsert: categorized.marketsToInsert,
        marketsToUpdatePrices: categorized.marketsToUpdatePrices,
        marketsNeedingEmbeddings: categorized.marketsNeedingEmbeddings,
      });

      embeddingsGenerated += batchEmbeddings;
    }

    logger.info("Fetched markets", { source, fetched });
  } catch (error) {
    const errMsg = error instanceof Error ? error.message : String(error);
    errors.push(errMsg);
    logger.error("Error syncing source", { source, error: errMsg });

    const result: SyncResult = {
      source,
      fetched,
      newMarkets,
      updatedPrices,
      contentChanged,
      embeddingsGenerated,
      errors,
      durationMs: Date.now() - startTime,
      status: "failed",
    };

    throw new SyncSourceError(source, errMsg, result);
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
    status: errors.length > 0 ? "failed" : "success",
  };
}

async function loadExistingMarkets(
  source: MarketSource,
  sourceIds: string[]
): Promise<Map<string, ExistingMarket>> {
  const existingBySourceId = new Map<string, ExistingMarket>();

  if (sourceIds.length === 0) {
    return existingBySourceId;
  }

  const DB_BATCH_SIZE = 5000;
  for (let i = 0; i < sourceIds.length; i += DB_BATCH_SIZE) {
    const batchIds = sourceIds.slice(i, i + DB_BATCH_SIZE);
    const batchResults = await db
      .select({
        id: markets.id,
        sourceId: markets.sourceId,
        contentHash: markets.contentHash,
        yesPrice: markets.yesPrice,
        noPrice: markets.noPrice,
        volume: markets.volume,
        volume24h: markets.volume24h,
        status: markets.status,
      })
      .from(markets)
      .where(
        and(eq(markets.source, source), inArray(markets.sourceId, batchIds))
      );

    for (const market of batchResults) {
      existingBySourceId.set(market.sourceId, market);
    }
  }

  return existingBySourceId;
}

async function applyBatchChanges({
  source,
  normalizedMarkets,
  existingBySourceId,
  marketsToInsert,
  marketsToUpdatePrices,
  marketsNeedingEmbeddings,
}: {
  source: MarketSource;
  normalizedMarkets: NormalizedMarket[];
  existingBySourceId: Map<string, ExistingMarket>;
  marketsToInsert: NormalizedMarket[];
  marketsToUpdatePrices: MarketPriceUpdate[];
  marketsNeedingEmbeddings: NormalizedMarket[];
}): Promise<number> {
  const syncedAt = new Date();
  let embeddingsGenerated = 0;

  const normalizedById = new Map(
    normalizedMarkets.map((market) => [market.id, market])
  );

  const useJobQueue = config.JOB_WORKER_ENABLED;

  // Step 1: Generate embeddings for new/changed markets (or enqueue jobs)
  let embeddings = new Map<string, number[]>();
  if (marketsNeedingEmbeddings.length > 0) {
    if (useJobQueue) {
      const jobBatchSize = 200;
      for (let i = 0; i < marketsNeedingEmbeddings.length; i += jobBatchSize) {
        const batchIds = marketsNeedingEmbeddings
          .slice(i, i + jobBatchSize)
          .map((market) => market.id);
        await enqueueEmbeddingJob(batchIds);
      }
    } else {
      logger.info("Generating embeddings", {
        source,
        count: marketsNeedingEmbeddings.length,
      });
      embeddings = await generateMarketEmbeddings(marketsNeedingEmbeddings);
      embeddingsGenerated = embeddings.size;
    }
  }

  // Step 2: Insert new markets into Postgres
  if (marketsToInsert.length > 0) {
    await insertMarketsBatch(marketsToInsert, syncedAt);
    await recordPriceHistoryFromMarkets(marketsToInsert, syncedAt);
    logger.info("Inserted new markets", {
      source,
      count: marketsToInsert.length,
    });
  }

  // Step 3: Update content for changed markets (batched)
  const contentUpdates = marketsNeedingEmbeddings.filter((market) =>
    existingBySourceId.has(market.sourceId)
  );

  if (contentUpdates.length > 0) {
    await updateMarketContentBatch(contentUpdates, syncedAt);
  }

  // Step 4: Upsert vectors to Qdrant after DB writes
  if (!useJobQueue && marketsNeedingEmbeddings.length > 0 && embeddings.size > 0) {
    await upsertMarkets(marketsNeedingEmbeddings, embeddings);
    logger.info("Upserted vectors to Qdrant", {
      source,
      vectors: embeddings.size,
    });
  }

  // Step 5: Batch update prices for existing markets
  if (marketsToUpdatePrices.length > 0) {
    await updateMarketPricesBatch(marketsToUpdatePrices, syncedAt);
    await recordPriceHistoryFromUpdates(marketsToUpdatePrices, syncedAt);
    logger.info("Batch updated markets", {
      source,
      count: marketsToUpdatePrices.length,
    });
  }

  // Step 6: Refresh payloads for markets with price/status changes
  if (marketsToUpdatePrices.length > 0) {
    const embeddingIds = new Set(
      marketsNeedingEmbeddings.map((market) => market.id)
    );
    const payloadRefreshMarkets = marketsToUpdatePrices
      .filter((update) => !embeddingIds.has(update.id))
      .map((update) => normalizedById.get(update.id))
      .filter((market): market is NormalizedMarket => Boolean(market));

    if (payloadRefreshMarkets.length > 0) {
      await updateMarketPayloads(payloadRefreshMarkets);
    }
  }

  await evaluateAlerts(marketsToUpdatePrices, normalizedMarkets, syncedAt);

  return embeddingsGenerated;
}

async function insertMarketsBatch(
  marketsToInsert: NormalizedMarket[],
  syncedAt: Date
): Promise<void> {
  const BATCH_SIZE = 100;
  for (let i = 0; i < marketsToInsert.length; i += BATCH_SIZE) {
    const batch = marketsToInsert.slice(i, i + BATCH_SIZE);
    const dbRecords: NewMarket[] = batch.map((market) => ({
      id: market.id,
      sourceId: market.sourceId,
      source: market.source,
      title: market.title,
      subtitle: market.subtitle,
      description: market.description,
      rules: market.rules,
      category: market.category,
      tags: market.tags,
      contentHash: market.contentHash,
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
      lastPrice: market.lastPrice,
      volume: market.volume,
      volume24h: market.volume24h,
      liquidity: market.liquidity,
      status: market.status,
      result: market.result,
      createdAt: market.createdAt,
      openAt: market.openAt,
      closeAt: market.closeAt,
      expiresAt: market.expiresAt,
      url: market.url,
      imageUrl: market.imageUrl,
      embeddingModel: EMBEDDING_MODEL,
      lastSyncedAt: syncedAt,
    }));

    await db.insert(markets).values(dbRecords);
  }
}

async function updateMarketPricesBatch(
  updates: MarketPriceUpdate[],
  syncedAt: Date
): Promise<void> {
  const BATCH_SIZE = 1000;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const values = batch.map(
      (update) =>
        sql`(${sql.param(update.id, markets.id)}, ${sql.param(update.yesPrice, markets.yesPrice)}, ${sql.param(update.noPrice, markets.noPrice)}, ${sql.param(update.volume, markets.volume)}, ${sql.param(update.volume24h, markets.volume24h)}, ${sql.param(update.status, markets.status)}, ${sql.param(syncedAt, markets.lastSyncedAt)})`
    );

      await db.execute(sql`
        UPDATE ${markets} AS m
        SET
          yes_price = v.yes_price::real,
          no_price = v.no_price::real,
          volume = v.volume::real,
          volume_24h = v.volume_24h::real,
          status = v.status::market_status,
          last_synced_at = v.last_synced_at::timestamp
        FROM (VALUES ${sql.join(values, sql`, `)})
          AS v(id, yes_price, no_price, volume, volume_24h, status, last_synced_at)
        WHERE m.id = v.id::uuid
      `);
  }
}

async function updateMarketContentBatch(
  updates: NormalizedMarket[],
  syncedAt: Date
): Promise<void> {
  const BATCH_SIZE = 200;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    const values = batch.map(
      (market) =>
        sql`(${sql.param(market.id, markets.id)}, ${sql.param(market.title, markets.title)}, ${sql.param(market.subtitle, markets.subtitle)}, ${sql.param(market.description, markets.description)}, ${sql.param(market.rules, markets.rules)}, ${sql.param(market.category, markets.category)}, ${sql.param(market.tags, markets.tags)}, ${sql.param(market.closeAt, markets.closeAt)}, ${sql.param(market.url, markets.url)}, ${sql.param(market.imageUrl, markets.imageUrl)}, ${sql.param(market.contentHash, markets.contentHash)}, ${sql.param(EMBEDDING_MODEL, markets.embeddingModel)}, ${sql.param(syncedAt, markets.lastSyncedAt)})`
    );

    await db.execute(sql`
      UPDATE ${markets} AS m
      SET
        title = v.title,
        subtitle = v.subtitle,
        description = v.description,
        rules = v.rules,
        category = v.category,
        tags = v.tags,
        close_at = v.close_at,
        url = v.url,
        image_url = v.image_url,
        content_hash = v.content_hash,
        embedding_model = v.embedding_model,
        last_synced_at = v.last_synced_at
      FROM (VALUES ${sql.join(values, sql`, `)})
        AS v(id, title, subtitle, description, rules, category, tags, close_at, url, image_url, content_hash, embedding_model, last_synced_at)
      WHERE m.id = v.id::uuid
    `);
  }
}

async function recordPriceHistoryFromMarkets(
  newMarkets: NormalizedMarket[],
  recordedAt: Date
): Promise<void> {
  const BATCH_SIZE = 1000;
  for (let i = 0; i < newMarkets.length; i += BATCH_SIZE) {
    const batch = newMarkets.slice(i, i + BATCH_SIZE);
    await db.insert(marketPriceHistory).values(
      batch.map((market) => ({
        marketId: market.id,
        yesPrice: market.yesPrice,
        noPrice: market.noPrice,
        volume: market.volume,
        volume24h: market.volume24h,
        status: market.status,
        recordedAt,
      }))
    );
  }
}

async function recordPriceHistoryFromUpdates(
  updates: MarketPriceUpdate[],
  recordedAt: Date
): Promise<void> {
  const BATCH_SIZE = 1000;
  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    const batch = updates.slice(i, i + BATCH_SIZE);
    await db.insert(marketPriceHistory).values(
      batch.map((update) => ({
        marketId: update.id,
        yesPrice: update.yesPrice,
        noPrice: update.noPrice,
        volume: update.volume,
        volume24h: update.volume24h,
        status: update.status,
        recordedAt,
      }))
    );
  }
}

async function evaluateAlerts(
  priceUpdates: MarketPriceUpdate[],
  normalizedMarkets: NormalizedMarket[],
  now: Date
): Promise<void> {
  const alertEventsToInsert: Array<{
    alertId: string;
    marketId: string;
    payload: Record<string, unknown>;
  }> = [];
  const alertIdsToUpdate = new Set<string>();
  const marketById = new Map(
    normalizedMarkets.map((market) => [market.id, market])
  );
  const updateById = new Map(
    priceUpdates.map((update) => [update.id, update])
  );

  if (priceUpdates.length > 0) {
    const marketIds = priceUpdates.map((update) => update.id);
    const marketCondition = buildUuidInCondition(alerts.marketId, marketIds);
    if (!marketCondition) {
      return;
    }
    const priceAlerts = await db
      .select()
      .from(alerts)
      .where(
        and(
          marketCondition,
          eq(alerts.type, "price_move"),
          eq(alerts.enabled, true)
        )
      );

    for (const alert of priceAlerts) {
      const update = updateById.get(alert.marketId);
      if (!update || !alert.threshold) continue;

      const previous = update.prevYesPrice;
      if (previous <= 0) continue;

      const change = Math.abs(update.yesPrice - previous) / previous;
      if (change < alert.threshold) continue;

      if (alert.lastTriggeredAt) {
        const elapsedMs = now.getTime() - alert.lastTriggeredAt.getTime();
        if (elapsedMs < 30 * 60 * 1000) continue;
      }

      alertEventsToInsert.push({
        alertId: alert.id,
        marketId: alert.marketId,
        payload: {
          type: "price_move",
          threshold: alert.threshold,
          previousYesPrice: previous,
          currentYesPrice: update.yesPrice,
          change,
        },
      });
      alertIdsToUpdate.add(alert.id);
    }
  }

  if (normalizedMarkets.length > 0) {
    const marketIds = normalizedMarkets.map((market) => market.id);
    const marketCondition = buildUuidInCondition(alerts.marketId, marketIds);
    if (!marketCondition) {
      return;
    }
    const closingAlerts = await db
      .select()
      .from(alerts)
      .where(
        and(
          marketCondition,
          eq(alerts.type, "closing_soon"),
          eq(alerts.enabled, true)
        )
      );

    for (const alert of closingAlerts) {
      const market = marketById.get(alert.marketId);
      if (!market?.closeAt) continue;

      const windowMinutes = alert.windowMinutes ?? 60;
      const timeToCloseMs = market.closeAt.getTime() - now.getTime();
      if (timeToCloseMs <= 0 || timeToCloseMs > windowMinutes * 60 * 1000) {
        continue;
      }

      if (alert.lastTriggeredAt) {
        const elapsedMs = now.getTime() - alert.lastTriggeredAt.getTime();
        if (elapsedMs < windowMinutes * 60 * 1000) continue;
      }

      alertEventsToInsert.push({
        alertId: alert.id,
        marketId: alert.marketId,
        payload: {
          type: "closing_soon",
          closeAt: market.closeAt.toISOString(),
          windowMinutes,
        },
      });
      alertIdsToUpdate.add(alert.id);
    }
  }

  if (alertEventsToInsert.length > 0) {
    const BATCH_SIZE = 500;
    for (let i = 0; i < alertEventsToInsert.length; i += BATCH_SIZE) {
      const batch = alertEventsToInsert.slice(i, i + BATCH_SIZE);
      await db.insert(alertEvents).values(
        batch.map((event) => ({
          alertId: event.alertId,
          marketId: event.marketId,
          payload: event.payload,
          triggeredAt: now,
        }))
      );
    }

    const alertIdCondition = buildUuidInCondition(
      alerts.id,
      Array.from(alertIdsToUpdate)
    );
    if (alertIdCondition) {
      await db
        .update(alerts)
        .set({ lastTriggeredAt: now })
        .where(alertIdCondition);
    }
  }
}

export { summarizeSyncResults, SyncSourceError, SyncRunError };
