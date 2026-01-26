import { describe, test, expect, mock, beforeAll, afterAll, beforeEach } from "bun:test";
import { eq } from "drizzle-orm";

// Global state for controlling mock behavior
const mockState = {
  failOpenai: false,
  failQdrant: false,
};

// Register mocks BEFORE any imports - these must be at top level
mock.module("../src/services/embedding/openrouter.ts", () => ({
  generateMarketEmbeddings: async (markets: Array<{ id: string }>) => {
    if (mockState.failOpenai) {
      throw new Error("OpenAI down");
    }
    return new Map(markets.map((market) => [market.id, [0.1, 0.2]]));
  },
  generateEmbedding: async () => [0.1, 0.2],
  generateEmbeddings: async (texts: string[]) => texts.map(() => [0.1, 0.2]),
  generateQueryEmbedding: async () => [0.1, 0.2],
  getEmbeddingCacheStats: () => ({ hits: 0, misses: 0, size: 0 }),
  EMBEDDING_MODEL: "test-embedding-model",
}));

mock.module("../src/services/search/qdrant.ts", () => ({
  ensureCollection: async () => {
    if (mockState.failQdrant) {
      throw new Error("Qdrant down");
    }
  },
  upsertMarkets: async () => {
    if (mockState.failQdrant) {
      throw new Error("Qdrant down");
    }
  },
  updateMarketPayloads: async () => {},
  search: async () => [],
  recommendMarkets: async () => [],
  getCollectionInfo: async () => ({ pointsCount: 0, vectorsCount: 0 }),
  checkQdrantHealth: async () => true,
  COLLECTION_NAME: "test-collection",
  qdrant: {},
}));

// Import modules AFTER mocks are registered
import { db, jobs, markets } from "../src/db/index.ts";
import { runJobWorkerOnce } from "../src/services/jobs/worker.ts";

async function seedMarket(marketId: string) {
  await db.insert(markets).values({
    id: marketId,
    sourceId: `job-${marketId}`,
    source: "polymarket",
    title: "Job test market",
    description: "Job test description",
    yesPrice: 0.5,
    noPrice: 0.5,
    volume: 0,
    volume24h: 0,
    status: "open",
    createdAt: new Date(),
    url: "https://example.com/job",
    lastSyncedAt: new Date(),
  });
}

describe("job worker retries", () => {
  beforeEach(() => {
    // Reset mock state before each test
    mockState.failOpenai = false;
    mockState.failQdrant = false;
  });

  test("requeues embed jobs when OpenAI fails", async () => {
    const marketId = crypto.randomUUID();
    const jobId = crypto.randomUUID();

    await seedMarket(marketId);

    await db.insert(jobs).values({
      id: jobId,
      type: "embed_market",
      payload: { marketIds: [marketId] },
      maxAttempts: 3,
      runAt: new Date(),
    });

    mockState.failOpenai = true;

    const startedAt = Date.now();

    try {
      await runJobWorkerOnce("worker-openai");

      const [jobRow] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId));

      expect(jobRow?.status).toBe("queued");
      expect(jobRow?.attempts).toBe(1);
      expect(jobRow?.lastError).toContain("OpenAI down");
      expect(jobRow?.runAt?.getTime()).toBeGreaterThan(startedAt);
    } finally {
      await db.delete(jobs).where(eq(jobs.id, jobId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });

  test("requeues embed jobs when Qdrant fails", async () => {
    const marketId = crypto.randomUUID();
    const jobId = crypto.randomUUID();

    await seedMarket(marketId);

    await db.insert(jobs).values({
      id: jobId,
      type: "embed_market",
      payload: { marketIds: [marketId] },
      maxAttempts: 3,
      runAt: new Date(),
    });

    mockState.failQdrant = true;

    const startedAt = Date.now();

    try {
      await runJobWorkerOnce("worker-qdrant");

      const [jobRow] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId));

      expect(jobRow?.status).toBe("queued");
      expect(jobRow?.attempts).toBe(1);
      expect(jobRow?.lastError).toContain("Qdrant down");
      expect(jobRow?.runAt?.getTime()).toBeGreaterThan(startedAt);
    } finally {
      await db.delete(jobs).where(eq(jobs.id, jobId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });

  test("marks jobs succeeded on successful embed", async () => {
    const marketId = crypto.randomUUID();
    const jobId = crypto.randomUUID();

    await seedMarket(marketId);

    await db.insert(jobs).values({
      id: jobId,
      type: "embed_market",
      payload: { marketIds: [marketId] },
      maxAttempts: 3,
      runAt: new Date(),
    });

    // Both mocks succeed (default state)

    try {
      const processed = await runJobWorkerOnce("worker-success");
      expect(processed).toBe(1);

      const [jobRow] = await db
        .select()
        .from(jobs)
        .where(eq(jobs.id, jobId));

      expect(jobRow?.status).toBe("succeeded");

      const [marketRow] = await db
        .select()
        .from(markets)
        .where(eq(markets.id, marketId));
      expect(marketRow?.embeddingModel).toBe("test-embedding-model");
    } finally {
      await db.delete(jobs).where(eq(jobs.id, jobId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });
});
