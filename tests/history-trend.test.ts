import { describe, test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import app from "../src/api/index.ts";
import {
  db,
  markets,
  marketPriceHistory,
} from "../src/db/index.ts";

describe("market history and trend endpoints", () => {
  test("paginates history and summarizes trends", async () => {
    const marketId = crypto.randomUUID();
    const now = Date.now();
    const baselineAt = new Date(now - 2 * 60 * 60 * 1000);
    const latestAt = new Date(now - 10 * 60 * 1000);

    await db.insert(markets).values({
      id: marketId,
      sourceId: `hist-${marketId}`,
      source: "polymarket",
      title: "History market",
      description: "history",
      yesPrice: 0.6,
      noPrice: 0.4,
      volume: 100,
      volume24h: 20,
      status: "open",
      createdAt: new Date(),
      url: "https://example.com/history",
      lastSyncedAt: new Date(),
    });

    await db.insert(marketPriceHistory).values([
      {
        marketId,
        yesPrice: 0.4,
        noPrice: 0.6,
        volume: 80,
        volume24h: 15,
        status: "open",
        recordedAt: baselineAt,
      },
      {
        marketId,
        yesPrice: 0.6,
        noPrice: 0.4,
        volume: 100,
        volume24h: 20,
        status: "open",
        recordedAt: latestAt,
      },
    ]);

    try {
      const historyRes = await app.request(
        `/api/markets/${marketId}/history?limit=1`
      );
      expect(historyRes.status).toBe(200);
      const historyJson = await historyRes.json();
      expect(historyJson.history.length).toBe(1);
      expect(historyJson.meta.nextCursor).toBeTruthy();

      const cursor = historyJson.meta.nextCursor as string;
      const historyRes2 = await app.request(
        `/api/markets/${marketId}/history?limit=1&cursor=${encodeURIComponent(
          cursor
        )}`
      );
      expect(historyRes2.status).toBe(200);
      const historyJson2 = await historyRes2.json();
      expect(historyJson2.history.length).toBe(1);

      const firstRecorded = new Date(historyJson.history[0].recordedAt).getTime();
      const secondRecorded = new Date(historyJson2.history[0].recordedAt).getTime();
      expect(firstRecorded).toBeGreaterThan(secondRecorded);

      const trendRes = await app.request(
        `/api/markets/${marketId}/trend?windowHours=1`
      );
      expect(trendRes.status).toBe(200);
      const trendJson = await trendRes.json();
      expect(trendJson.windowHours).toBe(1);
      expect(trendJson.delta).toBeCloseTo(0.2);
      expect(trendJson.percentChange).toBeCloseTo(0.5);
    } finally {
      await db
        .delete(marketPriceHistory)
        .where(eq(marketPriceHistory.marketId, marketId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });
});
