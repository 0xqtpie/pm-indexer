import { describe, test, expect } from "bun:test";
import { inArray } from "drizzle-orm";
import app from "../src/api/routes.ts";
import { db, markets } from "../src/db/index.ts";

describe("trending endpoints", () => {
  test("returns tags and categories by 24h volume", async () => {
    const tagSeed = crypto.randomUUID().slice(0, 8);
    const tagA = `tag-a-${tagSeed}`;
    const tagB = `tag-b-${tagSeed}`;
    const tagC = `tag-c-${tagSeed}`;
    const catA = `cat-a-${tagSeed}`;
    const catB = `cat-b-${tagSeed}`;

    const marketIds = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    const now = new Date();

    await db.insert(markets).values([
      {
        id: marketIds[0],
        sourceId: `trend-${marketIds[0]}`,
        source: "polymarket",
        title: "Trend market A",
        description: "trend",
        yesPrice: 0.5,
        noPrice: 0.5,
        volume: 0,
        volume24h: 1000,
        status: "open",
        createdAt: now,
        url: "https://example.com/trend-a",
        lastSyncedAt: now,
        tags: [tagA, tagB],
        category: catA,
      },
      {
        id: marketIds[1],
        sourceId: `trend-${marketIds[1]}`,
        source: "polymarket",
        title: "Trend market B",
        description: "trend",
        yesPrice: 0.5,
        noPrice: 0.5,
        volume: 0,
        volume24h: 500,
        status: "open",
        createdAt: now,
        url: "https://example.com/trend-b",
        lastSyncedAt: now,
        tags: [tagA],
        category: catB,
      },
      {
        id: marketIds[2],
        sourceId: `trend-${marketIds[2]}`,
        source: "polymarket",
        title: "Trend market C",
        description: "trend",
        yesPrice: 0.5,
        noPrice: 0.5,
        volume: 0,
        volume24h: 2000,
        status: "open",
        createdAt: now,
        url: "https://example.com/trend-c",
        lastSyncedAt: now,
        tags: [tagC],
        category: catA,
      },
    ]);

    try {
      const tagsRes = await app.request("/api/tags/trending?limit=200");
      expect(tagsRes.status).toBe(200);
      const tagsJson = await tagsRes.json();

      const tagVolumes: Record<string, number> = {};
      for (const row of tagsJson.tags ?? []) {
        tagVolumes[row.tag] = row.volume_24h;
      }

      expect(tagVolumes[tagA]).toBeCloseTo(1500);
      expect(tagVolumes[tagB]).toBeCloseTo(1000);
      expect(tagVolumes[tagC]).toBeCloseTo(2000);

      const categoriesRes = await app.request("/api/categories/trending?limit=200");
      expect(categoriesRes.status).toBe(200);
      const categoriesJson = await categoriesRes.json();

      const categoryVolumes: Record<string, number> = {};
      for (const row of categoriesJson.categories ?? []) {
        categoryVolumes[row.category] = row.volume_24h;
      }

      expect(categoryVolumes[catA]).toBeCloseTo(3000);
      expect(categoryVolumes[catB]).toBeCloseTo(500);
    } finally {
      await db.delete(markets).where(inArray(markets.id, marketIds));
    }
  });
});
