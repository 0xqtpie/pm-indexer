import { describe, test, expect } from "bun:test";
import { eq } from "drizzle-orm";
import app from "../src/api/index.ts";
import {
  db,
  markets,
  watchlists,
  watchlistItems,
  alerts,
  alertEvents,
} from "../src/db/index.ts";

describe("watchlists and alerts API", () => {
  test("creates watchlists and manages items", async () => {
    const ownerKey = `owner-${crypto.randomUUID()}`;
    const marketId = crypto.randomUUID();

    await db.insert(markets).values({
      id: marketId,
      sourceId: `wl-${marketId}`,
      source: "polymarket",
      title: "Watchlist market",
      description: "watchlist",
      yesPrice: 0.55,
      noPrice: 0.45,
      volume: 10,
      volume24h: 2,
      status: "open",
      createdAt: new Date(),
      url: "https://example.com/watchlist",
      lastSyncedAt: new Date(),
    });

    let watchlistId: string | null = null;

    try {
      const createRes = await app.request("/api/watchlists", {
        method: "POST",
        headers: {
          "x-user-id": ownerKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ name: `My list ${crypto.randomUUID()}` }),
      });

      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      watchlistId = created.id as string;

      const addRes = await app.request(`/api/watchlists/${watchlistId}/items`, {
        method: "POST",
        headers: {
          "x-user-id": ownerKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ marketId }),
      });
      expect(addRes.status).toBe(200);

      const listRes = await app.request("/api/watchlists", {
        headers: { "x-user-id": ownerKey },
      });
      expect(listRes.status).toBe(200);
      const listJson = await listRes.json();
      const rows = listJson.watchlists as Array<{ id: string; item_count: number }>;
      const listRow = rows.find((row) => row.id === watchlistId);
      expect(listRow?.item_count).toBe(1);

      const detailRes = await app.request(`/api/watchlists/${watchlistId}`, {
        headers: { "x-user-id": ownerKey },
      });
      expect(detailRes.status).toBe(200);
      const detailJson = await detailRes.json();
      expect(detailJson.items.length).toBe(1);
      expect(detailJson.items[0]?.id).toBe(marketId);

      const deleteRes = await app.request(
        `/api/watchlists/${watchlistId}/items/${marketId}`,
        { method: "DELETE", headers: { "x-user-id": ownerKey } }
      );
      expect(deleteRes.status).toBe(200);

      const detailResAfter = await app.request(`/api/watchlists/${watchlistId}`, {
        headers: { "x-user-id": ownerKey },
      });
      const detailAfterJson = await detailResAfter.json();
      expect(detailAfterJson.items.length).toBe(0);
    } finally {
      if (watchlistId) {
        await db
          .delete(watchlistItems)
          .where(eq(watchlistItems.watchlistId, watchlistId));
        await db.delete(watchlists).where(eq(watchlists.id, watchlistId));
      }
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });

  test("creates alerts and returns alert events", async () => {
    const ownerKey = `owner-${crypto.randomUUID()}`;
    const marketId = crypto.randomUUID();
    const watchlistId = crypto.randomUUID();

    await db.insert(markets).values({
      id: marketId,
      sourceId: `alert-${marketId}`,
      source: "polymarket",
      title: "Alert market",
      description: "alert",
      yesPrice: 0.6,
      noPrice: 0.4,
      volume: 11,
      volume24h: 3,
      status: "open",
      createdAt: new Date(),
      url: "https://example.com/alerts",
      lastSyncedAt: new Date(),
    });

    await db.insert(watchlists).values({
      id: watchlistId,
      ownerKey,
      name: `Alerts ${crypto.randomUUID()}`,
    });

    let alertId: string | null = null;
    let eventId: string | null = null;

    try {
      const invalidRes = await app.request(`/api/watchlists/${watchlistId}/alerts`, {
        method: "POST",
        headers: {
          "x-user-id": ownerKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ marketId, type: "price_move" }),
      });
      expect(invalidRes.status).toBe(400);
      const invalidJson = await invalidRes.json();
      expect(invalidJson.error.code).toBe("INVALID_REQUEST");

      const createRes = await app.request(`/api/watchlists/${watchlistId}/alerts`, {
        method: "POST",
        headers: {
          "x-user-id": ownerKey,
          "content-type": "application/json",
        },
        body: JSON.stringify({ marketId, type: "price_move", threshold: 0.05 }),
      });
      expect(createRes.status).toBe(201);
      const created = await createRes.json();
      alertId = created.id as string;

      eventId = crypto.randomUUID();
      await db.insert(alertEvents).values({
        id: eventId,
        alertId,
        marketId,
        triggeredAt: new Date(),
        payload: { type: "price_move", threshold: 0.05 },
      });

      const eventsRes = await app.request("/api/alerts?limit=10", {
        headers: { "x-user-id": ownerKey },
      });
      expect(eventsRes.status).toBe(200);
      const eventsJson = await eventsRes.json();
      expect(eventsJson.events.length).toBeGreaterThan(0);
      const event = eventsJson.events.find(
        (row: { id: string }) => row.id === eventId
      );
      expect(event?.alert_id).toBe(alertId);
      expect(event?.market_id).toBe(marketId);
    } finally {
      if (eventId) {
        await db.delete(alertEvents).where(eq(alertEvents.id, eventId));
      }
      if (alertId) {
        await db.delete(alerts).where(eq(alerts.id, alertId));
      }
      await db.delete(watchlists).where(eq(watchlists.id, watchlistId));
      await db.delete(markets).where(eq(markets.id, marketId));
    }
  });
});
