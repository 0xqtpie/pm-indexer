import { QdrantClient } from "@qdrant/js-client-rest";
import { config } from "../../config.ts";
import type { NormalizedMarket } from "../../types/market.ts";
import { EMBEDDING_DIMENSIONS } from "../embedding/openai.ts";

const COLLECTION_NAME = "markets";

const qdrant = new QdrantClient({
  url: config.QDRANT_URL,
});

export async function ensureCollection(): Promise<void> {
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
    console.log(`Created collection: ${COLLECTION_NAME}`);
  }
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
      payload: {
        source: market.source,
        sourceId: market.sourceId,
        title: market.title,
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
      },
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
  description: string;
  status: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  url: string;
  tags: string[];
  category: string | null;
}

export async function search(
  queryEmbedding: number[],
  filters: SearchFilters = {},
  limit: number = 20
): Promise<SearchResult[]> {
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
    filter: must.length > 0 ? { must } : undefined,
    with_payload: true,
  });

  return results.map((r) => ({
    id: r.id as string,
    score: r.score,
    source: r.payload?.source as string,
    sourceId: r.payload?.sourceId as string,
    title: r.payload?.title as string,
    description: r.payload?.description as string,
    status: r.payload?.status as string,
    yesPrice: r.payload?.yesPrice as number,
    noPrice: r.payload?.noPrice as number,
    volume: r.payload?.volume as number,
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
