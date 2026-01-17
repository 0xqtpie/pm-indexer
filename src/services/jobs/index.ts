import { db, jobs } from "../../db/index.ts";

export type EmbedMarketJobPayload = {
  marketIds: string[];
};

export async function enqueueEmbeddingJob(
  marketIds: string[]
): Promise<void> {
  if (marketIds.length === 0) return;

  await db.insert(jobs).values({
    type: "embed_market",
    payload: { marketIds },
    status: "queued",
  });
}
