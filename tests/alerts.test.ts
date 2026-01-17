import { describe, test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import { db, markets, watchlists, alerts, alertEvents } from "../src/db/index.ts";
import { evaluateAlerts } from "../src/services/sync/index.ts";
import type { NormalizedMarket } from "../src/types/market.ts";
import type { MarketPriceUpdate } from "../src/services/sync/diff.ts";

function buildMarket(id: string, closeAt?: Date): NormalizedMarket {
  const now = new Date();
  return {
    id,
    sourceId: `test-${id}`,
    source: "polymarket",
    title: "Test market",
    subtitle: undefined,
    description: "Test description",
    rules: undefined,
    category: "Test",
    tags: ["test"],
    contentHash: "hash",
    yesPrice: 0.6,
    noPrice: 0.4,
    lastPrice: undefined,
    volume: 100,
    volume24h: 10,
    liquidity: undefined,
    status: "open",
    result: null,
    createdAt: now,
    openAt: now,
    closeAt,
    expiresAt: undefined,
    url: "https://example.com",
    imageUrl: undefined,
    embedding: undefined,
    embeddingModel: undefined,
    lastSyncedAt: now,
  };
}

describe("alert evaluation", () => {
  test("price_move alerts trigger and respect cooldowns", async () => {
    const marketId = crypto.randomUUID();
    const watchlistId = crypto.randomUUID();
    const alertId = crypto.randomUUID();
    const ownerKey = "alerts-test-owner";

    await db.insert(markets).values({
      id: marketId,
      sourceId: `src-${marketId}`,
      source: "polymarket",
      title: "Alert market",
      description: "Alert test",
      yesPrice: 0.5,
      noPrice: 0.5,
      volume: 10,
      volume24h: 5,
      status: "open",
      createdAt: new Date(),
      url: "https://example.com/alert",
      lastSyncedAt: new Date(),
    });

    await db.insert(watchlists).values({
      id: watchlistId,
      ownerKey,
      name: `watch-${watchlistId}`,
    });

    await db.insert(alerts).values({
      id: alertId,
      watchlistId,
      marketId,
      type: "price_move",
      threshold: 0.1,
    });

    const update: MarketPriceUpdate = {
      id: marketId,
      yesPrice: 0.6,
      noPrice: 0.4,
      volume: 20,
      volume24h: 6,
      status: "open",
      prevYesPrice: 0.5,
      prevNoPrice: 0.5,
      prevVolume: 10,
      prevVolume24h: 5,
      prevStatus: "open",
    };

    try {
      const firstRun = new Date();
      await evaluateAlerts([update], [], firstRun);

      const eventsAfterFirst = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.alertId, alertId));
      expect(eventsAfterFirst.length).toBe(1);
      expect(eventsAfterFirst[0]?.payload).toMatchObject({
        type: "price_move",
        threshold: 0.1,
      });

      const alertAfterFirst = await db
        .select()
        .from(alerts)
        .where(eq(alerts.id, alertId));
      expect(alertAfterFirst[0]?.lastTriggeredAt).toBeDefined();

      const secondRun = new Date(firstRun.getTime() + 10 * 60 * 1000);
      await evaluateAlerts([update], [], secondRun);

      const eventsAfterSecond = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.alertId, alertId));
      expect(eventsAfterSecond.length).toBe(1);

      const thirdRun = new Date(firstRun.getTime() + 31 * 60 * 1000);
      const nextUpdate: MarketPriceUpdate = {
        ...update,
        prevYesPrice: update.yesPrice,
        prevNoPrice: update.noPrice,
        yesPrice: 0.75,
        noPrice: 0.25,
      };
      await evaluateAlerts([nextUpdate], [], thirdRun);

      const eventsAfterThird = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.alertId, alertId));
      expect(eventsAfterThird.length).toBe(2);
    } finally {
      await db
        .delete(alertEvents)
        .where(eq(alertEvents.alertId, alertId));
      await db.delete(alerts).where(eq(alerts.id, alertId));
      await db.delete(watchlists).where(eq(watchlists.id, watchlistId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });

  test("closing_soon alerts trigger and respect window cooldowns", async () => {
    const marketId = crypto.randomUUID();
    const watchlistId = crypto.randomUUID();
    const alertId = crypto.randomUUID();
    const ownerKey = "alerts-test-owner";

    const now = new Date();
    const closeAt = new Date(now.getTime() + 30 * 60 * 1000);

    await db.insert(markets).values({
      id: marketId,
      sourceId: `src-${marketId}`,
      source: "polymarket",
      title: "Closing soon market",
      description: "Alert test closing",
      yesPrice: 0.7,
      noPrice: 0.3,
      volume: 12,
      volume24h: 7,
      status: "open",
      createdAt: now,
      closeAt,
      url: "https://example.com/closing",
      lastSyncedAt: now,
    });

    await db.insert(watchlists).values({
      id: watchlistId,
      ownerKey,
      name: `watch-${watchlistId}`,
    });

    await db.insert(alerts).values({
      id: alertId,
      watchlistId,
      marketId,
      type: "closing_soon",
      windowMinutes: 60,
    });

    const normalized = buildMarket(marketId, closeAt);

    try {
      await evaluateAlerts([], [normalized], now);

      const eventsAfterFirst = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.alertId, alertId));
      expect(eventsAfterFirst.length).toBe(1);
      expect(eventsAfterFirst[0]?.payload).toMatchObject({
        type: "closing_soon",
        windowMinutes: 60,
      });

      const secondRun = new Date(now.getTime() + 10 * 60 * 1000);
      await evaluateAlerts([], [normalized], secondRun);

      const eventsAfterSecond = await db
        .select()
        .from(alertEvents)
        .where(eq(alertEvents.alertId, alertId));
      expect(eventsAfterSecond.length).toBe(1);

    } finally {
      await db
        .delete(alertEvents)
        .where(eq(alertEvents.alertId, alertId));
      await db.delete(alerts).where(eq(alerts.id, alertId));
      await db.delete(watchlists).where(eq(watchlists.id, watchlistId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });
});
