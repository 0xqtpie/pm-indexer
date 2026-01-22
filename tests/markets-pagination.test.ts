import { describe, test, expect } from "bun:test";
import { inArray } from "drizzle-orm";
import app from "../src/api/index.ts";
import { db, markets } from "../src/db/index.ts";

describe("markets listing pagination", () => {
  test("uses keyset cursors and supports field projection", async () => {
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    const now = Date.now();
    // Use future timestamps to ensure test markets sort before any seeded data
    // (seeded markets have createdAt = sync time, which would otherwise be newer)
    const createdOlder = new Date(now + 60 * 60 * 1000);      // 1 hour in future
    const createdNewer = new Date(now + 2 * 60 * 60 * 1000);  // 2 hours in future
    const closeAt = new Date("0001-01-01T00:00:00.000Z");

    await db.insert(markets).values([
      {
        id: idA,
        sourceId: `m-${idA}`,
        source: "polymarket",
        title: "Market A",
        description: "A",
        yesPrice: 0.4,
        noPrice: 0.6,
        volume: 10,
        volume24h: 2,
        status: "open",
        createdAt: createdOlder,
        closeAt: null,
        url: "https://example.com/a",
        lastSyncedAt: new Date(),
      },
      {
        id: idB,
        sourceId: `m-${idB}`,
        source: "polymarket",
        title: "Market B",
        description: "B",
        yesPrice: 0.6,
        noPrice: 0.4,
        volume: 12,
        volume24h: 3,
        status: "open",
        createdAt: createdNewer,
        closeAt,
        url: "https://example.com/b",
        lastSyncedAt: new Date(),
      },
    ]);

    try {
      const res = await app.request(
        "/api/markets?limit=1&sort=createdAt&order=desc&fields=id,title,createdAt"
      );
      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.markets.length).toBe(1);
      expect(json.markets[0].id).toBe(idB);
      expect(Object.keys(json.markets[0]).sort()).toEqual([
        "createdAt",
        "id",
        "title",
      ]);
      expect(json.meta.nextCursor).toBeTruthy();

      const cursor = encodeURIComponent(json.meta.nextCursor as string);
      const res2 = await app.request(
        `/api/markets?limit=1&sort=createdAt&order=desc&cursor=${cursor}&fields=id,title,createdAt`
      );
      expect(res2.status).toBe(200);
      const json2 = await res2.json();
      expect(json2.markets.length).toBe(1);
      expect(json2.markets[0].id).toBe(idA);

      const closeRes = await app.request(
        "/api/markets?limit=2&sort=closeAt&order=asc&fields=id,closeAt"
      );
      expect(closeRes.status).toBe(200);
      const closeJson = await closeRes.json();
      expect(closeJson.markets.length).toBe(2);
      expect(closeJson.markets[0].id).toBe(idB);
    } finally {
      await db.delete(markets).where(inArray(markets.id, [idA, idB]));
    }
  });

  test("rejects invalid fields and cursors", async () => {
    const fieldRes = await app.request("/api/markets?fields=notAField");
    expect(fieldRes.status).toBe(400);
    const fieldJson = await fieldRes.json();
    expect(fieldJson.error.code).toBe("INVALID_REQUEST");

    const cursorRes = await app.request("/api/markets?cursor=not-base64");
    expect(cursorRes.status).toBe(400);
    const cursorJson = await cursorRes.json();
    expect(cursorJson.error.code).toBe("INVALID_CURSOR");
  });
});
