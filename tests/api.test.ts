import { describe, test, expect } from "bun:test";
import app from "../src/api/routes.ts";
import { db, markets } from "../src/db/index.ts";
import { eq } from "drizzle-orm";

describe("API Routes", () => {
  test("GET /health returns 200", async () => {
    const res = await app.request("/health");
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.status).toBe("ok");
    expect(json.timestamp).toBeDefined();
  });

  test("GET /api/search requires q parameter", async () => {
    const res = await app.request("/api/search");
    expect(res.status).toBe(400);

    const json = await res.json();
    expect(json.error).toBe("Invalid query parameters");
  });

  test("GET /api/markets/:id returns 404 for non-existent market", async () => {
    const res = await app.request("/api/markets/00000000-0000-0000-0000-000000000000");
    expect(res.status).toBe(404);
  });

  test("GET /api/markets returns list", async () => {
    const res = await app.request("/api/markets?limit=5");
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.markets).toBeDefined();
    expect(json.meta).toBeDefined();
    expect(json.meta.limit).toBe(5);
  });

  test("GET /api/tags handles null tags", async () => {
    const id = crypto.randomUUID();
    await db.insert(markets).values({
      id,
      sourceId: `test-tags-${id}`,
      source: "polymarket",
      title: "Tags null market",
      description: "test",
      yesPrice: 0.5,
      noPrice: 0.5,
      volume: 0,
      volume24h: 0,
      status: "open",
      createdAt: new Date(),
      url: "https://example.com",
      lastSyncedAt: new Date(),
      tags: null as unknown as string[],
    });

    try {
      const res = await app.request("/api/tags");
      expect(res.status).toBe(200);
    } finally {
      await db.delete(markets).where(eq(markets.id, id));
    }
  });
});
