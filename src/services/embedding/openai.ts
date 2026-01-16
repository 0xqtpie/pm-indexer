import OpenAI from "openai";
import { config } from "../../config.ts";
import type { NormalizedMarket } from "../../types/market.ts";
import { buildEmbeddingText } from "../../types/market.ts";

const openai = new OpenAI({
  apiKey: config.OPENAI_API_KEY,
});

const EMBEDDING_MODEL = "text-embedding-3-small";
const EMBEDDING_DIMENSIONS = 1536;
const BATCH_SIZE = 100;

type CachedEmbedding = {
  embedding: number[];
  expiresAt: number;
};

const queryEmbeddingCache = new Map<string, CachedEmbedding>();
let cacheHits = 0;
let cacheMisses = 0;

export async function generateEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
    dimensions: EMBEDDING_DIMENSIONS,
  });

  return response.data[0]?.embedding ?? [];
}

export function getEmbeddingCacheStats() {
  return {
    hits: cacheHits,
    misses: cacheMisses,
    size: queryEmbeddingCache.size,
    maxEntries: config.QUERY_EMBEDDING_CACHE_MAX_ENTRIES,
    ttlSeconds: config.QUERY_EMBEDDING_CACHE_TTL_SECONDS,
  };
}

function getQueryCacheKey(text: string): string {
  return text.trim().toLowerCase();
}

function getCachedEmbedding(key: string): number[] | null {
  if (config.QUERY_EMBEDDING_CACHE_MAX_ENTRIES <= 0) {
    return null;
  }

  const entry = queryEmbeddingCache.get(key);
  if (!entry) {
    cacheMisses += 1;
    return null;
  }

  if (Date.now() > entry.expiresAt) {
    queryEmbeddingCache.delete(key);
    cacheMisses += 1;
    return null;
  }

  // Refresh LRU ordering.
  queryEmbeddingCache.delete(key);
  queryEmbeddingCache.set(key, entry);
  cacheHits += 1;
  return entry.embedding;
}

function setCachedEmbedding(key: string, embedding: number[]) {
  if (config.QUERY_EMBEDDING_CACHE_MAX_ENTRIES <= 0) {
    return;
  }

  const ttlMs = config.QUERY_EMBEDDING_CACHE_TTL_SECONDS * 1000;
  if (ttlMs <= 0) {
    return;
  }

  if (queryEmbeddingCache.has(key)) {
    queryEmbeddingCache.delete(key);
  }

  queryEmbeddingCache.set(key, {
    embedding,
    expiresAt: Date.now() + ttlMs,
  });

  while (queryEmbeddingCache.size > config.QUERY_EMBEDDING_CACHE_MAX_ENTRIES) {
    const oldestKey = queryEmbeddingCache.keys().next().value as string | undefined;
    if (!oldestKey) {
      break;
    }
    queryEmbeddingCache.delete(oldestKey);
  }
}

export async function generateQueryEmbedding(text: string): Promise<number[]> {
  const key = getQueryCacheKey(text);
  const cached = getCachedEmbedding(key);
  if (cached) {
    return cached;
  }

  const embedding = await generateEmbedding(text);
  if (embedding.length > 0) {
    setCachedEmbedding(key, embedding);
  }

  return embedding;
}

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  const embeddings: number[][] = [];

  // Process in batches
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    const batch = texts.slice(i, i + BATCH_SIZE);

    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: batch,
      dimensions: EMBEDDING_DIMENSIONS,
    });

    for (const item of response.data) {
      embeddings.push(item.embedding);
    }

    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < texts.length) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  return embeddings;
}

export async function generateMarketEmbeddings(
  markets: NormalizedMarket[]
): Promise<Map<string, number[]>> {
  const texts = markets.map(buildEmbeddingText);
  const embeddings = await generateEmbeddings(texts);

  const result = new Map<string, number[]>();
  for (let i = 0; i < markets.length; i++) {
    const market = markets[i];
    const embedding = embeddings[i];
    if (market && embedding) {
      result.set(market.id, embedding);
    }
  }

  return result;
}

export { EMBEDDING_MODEL, EMBEDDING_DIMENSIONS };
