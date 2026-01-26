import { describe, test, expect, beforeAll } from "bun:test";
import { generateEmbedding } from "../src/services/embedding/openrouter.ts";
import {
  search,
  getCollectionInfo,
  ensureCollection,
  updateMarketPayloads,
  qdrant,
  COLLECTION_NAME,
} from "../src/services/search/qdrant.ts";
import type { NormalizedMarket, MarketSource } from "../src/types/market.ts";

function marketFromPayload(
  id: string,
  payload: Record<string, unknown>
): NormalizedMarket {
  return {
    id,
    sourceId: payload.sourceId as string,
    source: payload.source as MarketSource,
    title: payload.title as string,
    subtitle: (payload.subtitle as string) ?? undefined,
    description: (payload.description as string) ?? "",
    rules: undefined,
    category: (payload.category as string) ?? undefined,
    tags: (payload.tags as string[]) ?? [],
    contentHash: "hash",
    yesPrice: (payload.yesPrice as number) ?? 0.5,
    noPrice: (payload.noPrice as number) ?? 0.5,
    lastPrice: undefined,
    volume: (payload.volume as number) ?? 0,
    volume24h: (payload.volume24h as number) ?? 0,
    liquidity: undefined,
    status: (payload.status as "open" | "closed" | "settled") ?? "open",
    result: null,
    createdAt: new Date(),
    openAt: undefined,
    closeAt: payload.closeAt ? new Date(payload.closeAt as string) : undefined,
    expiresAt: undefined,
    url: (payload.url as string) ?? "",
    imageUrl: undefined,
    embeddingModel: undefined,
    lastSyncedAt: new Date(),
  };
}

describe("Semantic Search Integration Tests", () => {
  beforeAll(async () => {
    await ensureCollection();
    const info = await getCollectionInfo();
    if (info.pointsCount < 1000) {
      throw new Error(
        `Insufficient test data: only ${info.pointsCount} vectors in Qdrant. Run 'bun run db:seed' first.`
      );
    }
    console.log(`Running tests against ${info.pointsCount} vectors`);
  });

  describe("Basic Search", () => {
    test("returns results for a valid query", async () => {
      const embedding = await generateEmbedding("bitcoin price prediction");
      const results = await search(embedding, {}, 10);

      expect(results.length).toBeGreaterThan(0);
      expect(results.length).toBeLessThanOrEqual(10);
      expect(results[0]).toHaveProperty("id");
      expect(results[0]).toHaveProperty("score");
      expect(results[0]).toHaveProperty("title");
    });

    test("respects limit parameter", async () => {
      const embedding = await generateEmbedding("election");
      const results5 = await search(embedding, {}, 5);
      const results20 = await search(embedding, {}, 20);

      expect(results5.length).toBeLessThanOrEqual(5);
      expect(results20.length).toBeLessThanOrEqual(20);
      expect(results20.length).toBeGreaterThan(results5.length);
    });

    test("returns scores between 0 and 1", async () => {
      const embedding = await generateEmbedding("stock market");
      const results = await search(embedding, {}, 10);

      for (const result of results) {
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(result.score).toBeLessThanOrEqual(1);
      }
    });

    test("returns results sorted by relevance (descending score)", async () => {
      const embedding = await generateEmbedding("cryptocurrency");
      const results = await search(embedding, {}, 20);

      for (let i = 1; i < results.length; i++) {
        expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
      }
    });
  });

  describe("Semantic Relevance", () => {
    test("bitcoin query returns crypto-related markets", async () => {
      const embedding = await generateEmbedding("bitcoin BTC cryptocurrency");
      const results = await search(embedding, {}, 10);

      const titles = results.map((r) => r.title.toLowerCase());
      const hasCryptoResult = titles.some(
        (t) =>
          t.includes("bitcoin") ||
          t.includes("btc") ||
          t.includes("crypto") ||
          t.includes("ethereum") ||
          t.includes("eth")
      );

      console.log(titles);

      expect(hasCryptoResult).toBe(true);
    });

    test("election query returns political markets", async () => {
      const embedding = await generateEmbedding(
        "presidential election vote poll"
      );
      const results = await search(embedding, {}, 10);

      const titles = results.map((r) => r.title.toLowerCase());
      const hasPoliticalResult = titles.some(
        (t) =>
          t.includes("election") ||
          t.includes("president") ||
          t.includes("vote") ||
          t.includes("poll") ||
          t.includes("trump") ||
          t.includes("biden") ||
          t.includes("democrat") ||
          t.includes("republican")
      );

      expect(hasPoliticalResult).toBe(true);
    });

    // Note: Sports markets are excluded by default (EXCLUDE_SPORTS=true)
    // This test verifies that sports queries still return results (nearest non-sports matches)
    test("sports query returns results even with sports excluded", async () => {
      const embedding = await generateEmbedding(
        "NFL football Super Bowl championship"
      );
      const results = await search(embedding, {}, 10);

      // Should still return some results (nearest semantic matches)
      expect(results.length).toBeGreaterThan(0);

      // Results should NOT contain sports markets when EXCLUDE_SPORTS=true
      const categories = results.map((r) => r.category?.toLowerCase() ?? "");
      const hasSportsCategory = categories.some((c) => c === "sports");
      expect(hasSportsCategory).toBe(false);
    });

    test("weather query returns weather-related markets", async () => {
      const embedding = await generateEmbedding(
        "temperature weather climate hurricane"
      );
      const results = await search(embedding, {}, 10);

      const titles = results.map((r) => r.title.toLowerCase());
      const hasWeatherResult = titles.some(
        (t) =>
          t.includes("temperature") ||
          t.includes("weather") ||
          t.includes("climate") ||
          t.includes("hurricane") ||
          t.includes("storm") ||
          t.includes("rain") ||
          t.includes("snow") ||
          t.includes("heat") ||
          t.includes("cold")
      );

      expect(hasWeatherResult).toBe(true);
    });

    test("semantic similarity: 'crypto' and 'bitcoin' return similar content", async () => {
      const cryptoEmbedding = await generateEmbedding("crypto");
      const bitcoinEmbedding = await generateEmbedding("bitcoin");

      const cryptoResults = await search(cryptoEmbedding, {}, 50);
      const bitcoinResults = await search(bitcoinEmbedding, {}, 50);

      // Both queries should return crypto-related results
      const cryptoTitles = cryptoResults.map((r) => r.title.toLowerCase());
      const bitcoinTitles = bitcoinResults.map((r) => r.title.toLowerCase());

      const cryptoHasCryptoContent = cryptoTitles.some(
        (t) =>
          t.includes("crypto") ||
          t.includes("bitcoin") ||
          t.includes("btc") ||
          t.includes("eth")
      );
      const bitcoinHasCryptoContent = bitcoinTitles.some(
        (t) =>
          t.includes("crypto") ||
          t.includes("bitcoin") ||
          t.includes("btc") ||
          t.includes("eth")
      );

      expect(cryptoHasCryptoContent).toBe(true);
      expect(bitcoinHasCryptoContent).toBe(true);
    });
  });

  describe("Source Filtering", () => {
    test("filters by polymarket source", async () => {
      const embedding = await generateEmbedding("prediction market");
      const results = await search(embedding, { source: "polymarket" }, 20);

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.source).toBe("polymarket");
      }
    });

    test("filters by kalshi source", async () => {
      const embedding = await generateEmbedding("prediction market");
      const results = await search(embedding, { source: "kalshi" }, 20);

      expect(results.length).toBeGreaterThan(0);
      for (const result of results) {
        expect(result.source).toBe("kalshi");
      }
    });

    test("different sources return different results", async () => {
      const embedding = await generateEmbedding("economy inflation");

      const polyResults = await search(embedding, { source: "polymarket" }, 10);
      const kalshiResults = await search(embedding, { source: "kalshi" }, 10);

      const polyIds = new Set(polyResults.map((r) => r.id));
      const kalshiIds = new Set(kalshiResults.map((r) => r.id));

      // No overlap between sources
      const overlap = [...polyIds].filter((id) => kalshiIds.has(id));
      expect(overlap.length).toBe(0);
    });
  });

  describe("Status Filtering", () => {
    test("filters by open status", async () => {
      const embedding = await generateEmbedding("market");
      const results = await search(embedding, { status: "open" }, 20);

      for (const result of results) {
        console.log(result.title, result.status);
        expect(result.status).toBe("open");
      }
    });

    test("filters by closed status", async () => {
      const embedding = await generateEmbedding("market");
      const results = await search(embedding, { status: "closed" }, 20);

      for (const result of results) {
        expect(result.status).toBe("closed");
      }
    });
  });

  describe("Volume Filtering", () => {
    test("filters by minimum volume", async () => {
      const embedding = await generateEmbedding("popular market");
      const minVolume = 10000;
      const results = await search(embedding, { minVolume }, 20);

      for (const result of results) {
        expect(result.volume).toBeGreaterThanOrEqual(minVolume);
      }
    });

    test("higher minVolume returns fewer results", async () => {
      const embedding = await generateEmbedding("market");

      const lowVolResults = await search(embedding, { minVolume: 1000 }, 100);
      const highVolResults = await search(
        embedding,
        { minVolume: 100000 },
        100
      );

      expect(lowVolResults.length).toBeGreaterThanOrEqual(
        highVolResults.length
      );
    });
  });

  describe("Combined Filters", () => {
    test("combines source and status filters", async () => {
      const embedding = await generateEmbedding("election");
      const results = await search(
        embedding,
        { source: "polymarket", status: "open" },
        20
      );

      for (const result of results) {
        expect(result.source).toBe("polymarket");
        expect(result.status).toBe("open");
      }
    });

    test("combines source and volume filters", async () => {
      const embedding = await generateEmbedding("crypto");
      const minVolume = 5000;
      const results = await search(
        embedding,
        { source: "kalshi", minVolume },
        20
      );

      for (const result of results) {
        expect(result.source).toBe("kalshi");
        expect(result.volume).toBeGreaterThanOrEqual(minVolume);
      }
    });

    test("combines all filters", async () => {
      const embedding = await generateEmbedding("price prediction");
      const minVolume = 1000;
      const results = await search(
        embedding,
        { source: "polymarket", status: "open", minVolume },
        20
      );

      for (const result of results) {
        expect(result.source).toBe("polymarket");
        expect(result.status).toBe("open");
        expect(result.volume).toBeGreaterThanOrEqual(minVolume);
      }
    });
  });

  describe("Result Structure", () => {
    test("returns all expected fields", async () => {
      const embedding = await generateEmbedding("test query");
      const results = await search(embedding, {}, 5);

      expect(results.length).toBeGreaterThan(0);

      const result = results[0];
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("score");
      expect(result).toHaveProperty("source");
      expect(result).toHaveProperty("sourceId");
      expect(result).toHaveProperty("title");
      expect(result).toHaveProperty("description");
      expect(result).toHaveProperty("status");
      expect(result).toHaveProperty("yesPrice");
      expect(result).toHaveProperty("noPrice");
      expect(result).toHaveProperty("volume");
      expect(result).toHaveProperty("url");
      expect(result).toHaveProperty("tags");
    });

    test("prices are valid probabilities", async () => {
      const embedding = await generateEmbedding("market");
      const results = await search(embedding, {}, 20);

      for (const result of results) {
        expect(result.yesPrice).toBeGreaterThanOrEqual(0);
        expect(result.yesPrice).toBeLessThanOrEqual(1);
        expect(result.noPrice).toBeGreaterThanOrEqual(0);
        expect(result.noPrice).toBeLessThanOrEqual(1);
      }
    });

    test("URLs are valid", async () => {
      const embedding = await generateEmbedding("market");
      const results = await search(embedding, {}, 20);

      for (const result of results) {
        expect(result.url).toMatch(/^https?:\/\//);
      }
    });

    test("payload updates are visible in search results", async () => {
      const embedding = await generateEmbedding("market");
      const results = await search(embedding, {}, 5);

      expect(results.length).toBeGreaterThan(0);
      const target = results[0];

      const retrieved = await qdrant.retrieve(COLLECTION_NAME, {
        ids: [target.id],
        with_payload: true,
        with_vector: false,
      });
      const payload = retrieved[0]?.payload as Record<string, unknown> | undefined;

      expect(payload).toBeDefined();
      if (!payload) return;

      const originalMarket = marketFromPayload(target.id, payload);
      const updatedMarket: NormalizedMarket = {
        ...originalMarket,
        yesPrice: 0.01,
        noPrice: 0.99,
        status: "closed",
      };

      try {
        await updateMarketPayloads([updatedMarket]);

        const updatedResults = await search(embedding, {}, 5);
        const updatedTarget = updatedResults.find((r) => r.id === target.id);

        expect(updatedTarget).toBeDefined();
        expect(updatedTarget?.status).toBe("closed");
        expect(updatedTarget?.yesPrice).toBeCloseTo(0.01);
        expect(updatedTarget?.noPrice).toBeCloseTo(0.99);
      } finally {
        await updateMarketPayloads([originalMarket]);
      }
    });
  });

  describe("Edge Cases", () => {
    test("handles empty/generic query", async () => {
      const embedding = await generateEmbedding("aa");
      const results = await search(embedding, {}, 10);

      // Should still return results
      expect(results.length).toBeGreaterThan(0);
    });

    test("handles very specific query with no exact match", async () => {
      const embedding = await generateEmbedding(
        "extremely specific query about something unlikely to exist xyz123"
      );
      const results = await search(embedding, {}, 10);

      // Should still return some results (nearest neighbors)
      expect(results.length).toBeGreaterThan(0);
      // But scores should be lower
      expect(results[0].score).toBeLessThan(0.9);
    });

    test("handles limit of 1", async () => {
      const embedding = await generateEmbedding("market");
      const results = await search(embedding, {}, 1);

      expect(results.length).toBe(1);
    });

    test("handles large limit", async () => {
      const embedding = await generateEmbedding("market");
      const results = await search(embedding, {}, 100);

      expect(results.length).toBeLessThanOrEqual(100);
      expect(results.length).toBeGreaterThan(50); // Should have plenty of results
    });
  });
});
