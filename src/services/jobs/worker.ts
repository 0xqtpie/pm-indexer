import { sql, inArray } from "drizzle-orm";
import { db, jobs, markets } from "../../db/index.ts";
import { ensureCollection, upsertMarkets } from "../search/qdrant.ts";
import { generateMarketEmbeddings, EMBEDDING_MODEL } from "../embedding/openai.ts";
import type { Market, Job } from "../../db/schema.ts";
import type { NormalizedMarket } from "../../types/market.ts";
import { logger } from "../../logger.ts";
import { config } from "../../config.ts";

const DEFAULT_BATCH_SIZE = 10;

function normalizeMarket(record: Market): NormalizedMarket {
  return {
    id: record.id,
    sourceId: record.sourceId,
    source: record.source,
    title: record.title,
    subtitle: record.subtitle ?? undefined,
    description: record.description,
    rules: record.rules ?? undefined,
    category: record.category ?? undefined,
    tags: record.tags ?? [],
    contentHash: record.contentHash ?? "",
    yesPrice: record.yesPrice,
    noPrice: record.noPrice,
    lastPrice: record.lastPrice ?? undefined,
    volume: record.volume,
    volume24h: record.volume24h,
    liquidity: record.liquidity ?? undefined,
    status: record.status,
    result: record.result ?? null,
    createdAt: record.createdAt,
    openAt: record.openAt ?? undefined,
    closeAt: record.closeAt ?? undefined,
    expiresAt: record.expiresAt ?? undefined,
    url: record.url,
    imageUrl: record.imageUrl ?? undefined,
    embeddingModel: record.embeddingModel ?? undefined,
    lastSyncedAt: record.lastSyncedAt,
  };
}

async function markJobSucceeded(jobId: string) {
  await db
    .update(jobs)
    .set({
      status: "succeeded",
      updatedAt: new Date(),
    })
    .where(sql`${jobs.id} = ${jobId}`);
}

async function markJobFailed(job: Job, error: string) {
  const nextRun = new Date(Date.now() + Math.min(60000, 1000 * 2 ** job.attempts));
  const shouldRetry = job.attempts < job.maxAttempts;

  await db
    .update(jobs)
    .set({
      status: shouldRetry ? "queued" : "failed",
      runAt: shouldRetry ? nextRun : job.runAt,
      lastError: error,
      updatedAt: new Date(),
    })
    .where(sql`${jobs.id} = ${job.id}`);
}

async function processEmbedJob(job: Job) {
  const payload = job.payload as { marketIds?: unknown } | null;
  const marketIds = Array.isArray(payload?.marketIds)
    ? payload?.marketIds.filter((id) => typeof id === "string")
    : [];

  if (marketIds.length === 0) {
    throw new Error("Invalid embed job payload");
  }

  const records = await db
    .select()
    .from(markets)
    .where(inArray(markets.id, marketIds));

  if (records.length === 0) {
    throw new Error("No markets found for embed job");
  }

  const normalized = records.map(normalizeMarket);
  const embeddings = await generateMarketEmbeddings(normalized);

  await ensureCollection();
  await upsertMarkets(normalized, embeddings);

  await db
    .update(markets)
    .set({ embeddingModel: EMBEDDING_MODEL })
    .where(inArray(markets.id, marketIds));
}

export async function runJobWorkerOnce(workerId: string): Promise<number> {
  const rows = (await db.execute(sql`
    UPDATE ${jobs}
    SET
      status = 'processing',
      locked_at = NOW(),
      locked_by = ${workerId},
      attempts = attempts + 1,
      updated_at = NOW()
    WHERE id IN (
      SELECT id
      FROM ${jobs}
      WHERE status = 'queued'
        AND run_at <= NOW()
        AND attempts < max_attempts
      ORDER BY run_at
      LIMIT ${DEFAULT_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING
      id,
      type,
      status,
      payload,
      attempts,
      max_attempts AS "maxAttempts",
      run_at AS "runAt",
      locked_at AS "lockedAt",
      locked_by AS "lockedBy",
      last_error AS "lastError",
      created_at AS "createdAt",
      updated_at AS "updatedAt"
  `)) as Job[];

  if (rows.length === 0) {
    return 0;
  }

  for (const job of rows) {
    try {
      if (job.type === "embed_market") {
        await processEmbedJob(job);
      } else {
        throw new Error(`Unknown job type: ${job.type}`);
      }
      await markJobSucceeded(job.id);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn("Job failed", { jobId: job.id, error: message });
      await markJobFailed(job, message);
    }
  }

  return rows.length;
}

export function startJobWorker(): void {
  if (!config.JOB_WORKER_ENABLED) {
    return;
  }

  const workerId = `worker-${process.pid}`;
  logger.info("Starting job worker", { workerId });

  setInterval(() => {
    runJobWorkerOnce(workerId).catch((error) => {
      logger.error("Job worker error", {
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }, config.JOB_WORKER_POLL_MS);
}
