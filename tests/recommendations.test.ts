import { describe, test, expect, mock } from "bun:test";

const seedId = crypto.randomUUID();

// Import the real module to preserve exports that aren't being mocked
const realQdrant = await import("../src/services/search/qdrant.ts");

mock.module("../src/services/search/qdrant.ts", () => ({
  // Preserve all real exports
  ...realQdrant,
  // Override only what this test needs
  recommendMarkets: async () => [
    {
      id: seedId,
      score: 0.99,
      source: "polymarket",
      sourceId: "seed",
      title: "Seed market",
      subtitle: null,
      description: "seed",
      status: "open",
      yesPrice: 0.5,
      noPrice: 0.5,
      volume: 100,
      closeAt: null,
      url: "https://example.com/seed",
      tags: ["seed"],
      category: "Seed",
    },
    {
      id: "rec-1",
      score: 0.9,
      source: "polymarket",
      sourceId: "r1",
      title: "Rec one",
      subtitle: null,
      description: "rec",
      status: "open",
      yesPrice: 0.6,
      noPrice: 0.4,
      volume: 200,
      closeAt: null,
      url: "https://example.com/r1",
      tags: ["rec"],
      category: "Rec",
    },
    {
      id: "rec-2",
      score: 0.8,
      source: "kalshi",
      sourceId: "r2",
      title: "Rec two",
      subtitle: null,
      description: "rec2",
      status: "open",
      yesPrice: 0.4,
      noPrice: 0.6,
      volume: 150,
      closeAt: null,
      url: "https://example.com/r2",
      tags: ["rec"],
      category: "Rec",
    },
  ],
}));

describe("recommendations endpoint", () => {
  test("excludes seed market and respects fields projection", async () => {
    const { default: app } = await import("../src/api/index.ts");

    const res = await app.request(
      `/api/markets/${seedId}/recommendations?limit=2&fields=id,title,score`
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.marketId).toBe(seedId);
    expect(json.recommendations.length).toBe(2);

    for (const rec of json.recommendations) {
      expect(rec.id).not.toBe(seedId);
      expect(Object.keys(rec).sort()).toEqual(["id", "score", "title"]);
    }
  });
});
