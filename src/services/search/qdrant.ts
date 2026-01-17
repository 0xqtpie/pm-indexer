import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../../config.ts";
import type { NormalizedMarket } from "../../types/market.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/openai.ts";
import { logger } from "../../logger.ts";

const COLLECTION_NAME = "markets";

const qdrant = new QdrantClient({
  url: config.QDRANT_URL,
});

let collectionReady = false;
let ensurePromise: Promise<void> | null = null;

export async function ensureCollection(): Promise<void> {
  if (collectionReady) return;
  if (ensurePromise) return ensurePromise;

  ensurePromise = (async () => {
    const collections = await qdrant.getCollections();
    const exists = collections.collections.some(
      (c) => c.name === COLLECTION_NAME
    );

    if (!exists) {
      await qdrant.createCollection(COLLECTION_NAME, {
        vectors: {
          size: EMBEDDING_DIMENSIONS,
          distance: "Cosine",
        },
      });
      logger.info("Created collection", { collection: COLLECTION_NAME });
    }

    collectionReady = true;
    ensurePromise = null;
  })();

  return ensurePromise;
}

function buildMarketPayload(market: NormalizedMarket) {
  return {
    source: market.source,
    sourceId: market.sourceId,
    title: market.title,
    subtitle: market.subtitle ?? null,
    description: market.description.slice(0, 1000), // Truncate for payload
    status: market.status,
    yesPrice: market.yesPrice,
    noPrice: market.noPrice,
    volume: market.volume,
    volume24h: market.volume24h,
    closeAt: market.closeAt?.toISOString() ?? null,
    url: market.url,
    tags: market.tags,
    category: market.category ?? null,
  };
}

export async function upsertMarkets(
  markets: NormalizedMarket[],
  embeddings: Map<string, number[]>
): Promise<void> {
  const points = markets
    .filter((m) => embeddings.has(m.id))
    .map((market) => ({
      id: market.id,
      vector: embeddings.get(market.id)!,
      payload: buildMarketPayload(market),
    }));

  // Upsert in batches of 100
  const BATCH_SIZE = 100;
  for (let i = 0; i < points.length; i += BATCH_SIZE) {
    const batch = points.slice(i, i + BATCH_SIZE);
    await qdrant.upsert(COLLECTION_NAME, {
      wait: true,
      points: batch,
    });
  }
}

export async function updateMarketPayloads(
  markets: NormalizedMarket[]
): Promise<void> {
  if (markets.length === 0) return;

  const operations = markets.map((market) => ({
    set_payload: {
      points: [market.id],
      payload: buildMarketPayload(market),
    },
  }));

  const BATCH_SIZE = 100;
  for (let i = 0; i < operations.length; i += BATCH_SIZE) {
    const batch = operations.slice(i, i + BATCH_SIZE);
    await qdrant.batchUpdate(COLLECTION_NAME, {
      wait: true,
      operations: batch,
    });
  }
}

export interface SearchFilters {
  source?: "polymarket" | "kalshi";
  status?: "open" | "closed" | "settled";
  minVolume?: number;
}

export interface SearchResult {
  id: string;
  score: number;
  source: string;
  sourceId: string;
  title: string;
  subtitle: string | null;
  description: string;
  status: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  closeAt: string | null;
  url: string;
  tags: string[];
  category: string | null;
}

export async function search(
  queryEmbedding: number[],
  filters: SearchFilters = {},
  limit: number = 20,
  offset: number = 0
): Promise<SearchResult[]> {
  await ensureCollection();
  const must: Array<Record<string, unknown>> = [];

  if (filters.source) {
    must.push({ key: "source", match: { value: filters.source } });
  }

  if (filters.status) {
    must.push({ key: "status", match: { value: filters.status } });
  }

  if (filters.minVolume !== undefined) {
    must.push({ key: "volume", range: { gte: filters.minVolume } });
  }

  const results = await qdrant.search(COLLECTION_NAME, {
    vector: queryEmbedding,
    limit,
    offset,
    filter: must.length > 0 ? { must } : undefined,
    with_payload: true,
  });

  return results.map((r) => ({
    id: r.id as string,
    score: r.score,
    source: r.payload?.source as string,
    sourceId: r.payload?.sourceId as string,
    title: r.payload?.title as string,
    subtitle: (r.payload?.subtitle as string) ?? null,
    description: r.payload?.description as string,
    status: r.payload?.status as string,
    yesPrice: r.payload?.yesPrice as number,
    noPrice: r.payload?.noPrice as number,
    volume: r.payload?.volume as number,
    closeAt: (r.payload?.closeAt as string) ?? null,
    url: r.payload?.url as string,
    tags: (r.payload?.tags as string[]) ?? [],
    category: (r.payload?.category as string) ?? null,
  }));
}

export async function recommendMarkets(
  positiveIds: string[],
  filters: SearchFilters = {},
  limit: number = 10
): Promise<SearchResult[]> {
  if (positiveIds.length === 0) return [];

  await ensureCollection();
  const must: Array<Record<string, unknown>> = [];

  if (filters.source) {
    must.push({ key: "source", match: { value: filters.source } });
  }

  if (filters.status) {
    must.push({ key: "status", match: { value: filters.status } });
  }

  if (filters.minVolume !== undefined) {
    must.push({ key: "volume", range: { gte: filters.minVolume } });
  }

  const results = await qdrant.recommend(COLLECTION_NAME, {
    positive: positiveIds,
    limit,
    filter: must.length > 0 ? { must } : undefined,
    with_payload: true,
  });

  return results.map((r) => ({
    id: r.id as string,
    score: r.score,
    source: r.payload?.source as string,
    sourceId: r.payload?.sourceId as string,
    title: r.payload?.title as string,
    subtitle: (r.payload?.subtitle as string) ?? null,
    description: r.payload?.description as string,
    status: r.payload?.status as string,
    yesPrice: r.payload?.yesPrice as number,
    noPrice: r.payload?.noPrice as number,
    volume: r.payload?.volume as number,
    closeAt: (r.payload?.closeAt as string) ?? null,
    url: r.payload?.url as string,
    tags: (r.payload?.tags as string[]) ?? [],
    category: (r.payload?.category as string) ?? null,
  }));
}

export async function getCollectionInfo(): Promise<{
  vectorsCount: number;
  pointsCount: number;
}> {
  const info = await qdrant.getCollection(COLLECTION_NAME);
  // points_count is the actual number of vectors stored
  // indexed_vectors_count may be 0 if below indexing threshold
  return {
    vectorsCount: info.points_count ?? 0,
    pointsCount: info.points_count ?? 0,
  };
}

export { COLLECTION_NAME, qdrant };
