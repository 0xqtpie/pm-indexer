import { describe, test, expect, mock } from "bun:test";
import { eq } from "drizzle-orm";

let failOpenai = false;
let failQdrant = false;

mock.module("../src/services/embedding/openai.ts", () => ({
  generateMarketEmbeddings: async (markets: Array<{ id: string }>) => {
    if (failOpenai) {
      throw new Error("OpenAI down");
    }
    return new Map(markets.map((market) => [market.id, [0.1, 0.2]]));
  },
  EMBEDDING_MODEL: "test-embedding-model",
}));

mock.module("../src/services/search/qdrant.ts", () => ({
  ensureCollection: async () => {
    if (failQdrant) {
      throw new Error("Qdrant down");
    }
  },
  upsertMarkets: async () => {
    if (failQdrant) {
      throw new Error("Qdrant down");
    }
  },
}));

async function seedMarket(marketId: string) {
  const { db, markets } = await import("../src/db/index.ts");
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
  test("requeues embed jobs when OpenAI fails", async () => {
    const { db, jobs, markets } = await import("../src/db/index.ts");
    const { runJobWorkerOnce } = await import("../src/services/jobs/worker.ts");

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

    failOpenai = true;
    failQdrant = false;

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
      failOpenai = false;
      await db.delete(jobs).where(eq(jobs.id, jobId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });

  test("requeues embed jobs when Qdrant fails", async () => {
    const { db, jobs, markets } = await import("../src/db/index.ts");
    const { runJobWorkerOnce } = await import("../src/services/jobs/worker.ts");

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

    failOpenai = false;
    failQdrant = true;

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
      failQdrant = false;
      await db.delete(jobs).where(eq(jobs.id, jobId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });
});
