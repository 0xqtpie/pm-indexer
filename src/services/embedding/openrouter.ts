import OpenAI from "openai";
import { config } from "../../config.ts";
import type { NormalizedMarket } from "../../types/market.ts";
import { buildEmbeddingText } from "../../types/market.ts";

// OpenRouter provides access to multiple embedding providers via OpenAI-compatible API
const openrouter = new OpenAI({
  apiKey: config.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
});

const EMBEDDING_MODEL = config.EMBEDDING_MODEL;
const EMBEDDING_DIMENSIONS = config.EMBEDDING_DIMENSIONS;
const BATCH_SIZE = 100;

type CachedEmbedding = {
  embedding: number[];
  expiresAt: number;
};

const queryEmbeddingCache = new Map<string, CachedEmbedding>();
let cacheHits = 0;
let cacheMisses = 0;

export async function generateEmbedding(text: string): Promise<number[]> {
  // Only include dimensions if specified (text-embedding-3 models support it, ada-002 doesn't)
  const params: { model: string; input: string; dimensions?: number } = {
    model: EMBEDDING_MODEL,
    input: text,
  };
  if (EMBEDDING_DIMENSIONS > 0) {
    params.dimensions = EMBEDDING_DIMENSIONS;
  }

  const response = await openrouter.embeddings.create(params);
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

async function processBatch(
  batch: string[],
  batchIndex: number
): Promise<{ index: number; embeddings: number[][] }> {
  const params: { model: string; input: string[]; dimensions?: number } = {
    model: EMBEDDING_MODEL,
    input: batch,
  };
  if (EMBEDDING_DIMENSIONS > 0) {
    params.dimensions = EMBEDDING_DIMENSIONS;
  }

  const response = await openrouter.embeddings.create(params);

  // Sort by index to ensure correct order (API may return out of order)
  const sorted = [...response.data].sort((a, b) => a.index - b.index);

  return {
    index: batchIndex,
    embeddings: sorted.map((item) => item.embedding),
  };
}

export async function generateEmbeddings(
  texts: string[]
): Promise<number[][]> {
  if (texts.length === 0) {
    return [];
  }

  // Split into batches
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += BATCH_SIZE) {
    batches.push(texts.slice(i, i + BATCH_SIZE));
  }

  const concurrency = config.EMBEDDING_CONCURRENCY;
  const results: { index: number; embeddings: number[][] }[] = [];

  // Process batches with concurrency limit
  for (let i = 0; i < batches.length; i += concurrency) {
    const chunk = batches.slice(i, i + concurrency);
    const chunkResults = await Promise.all(
      chunk.map((batch, j) => processBatch(batch, i + j))
    );
    results.push(...chunkResults);
  }

  // Sort by original index and flatten
  results.sort((a, b) => a.index - b.index);
  return results.flatMap((r) => r.embeddings);
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
