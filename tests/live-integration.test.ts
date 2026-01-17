import { describe, test } from "bun:test";
import { fetchPolymarketMarkets } from "../src/services/ingestion/polymarket.ts";
import { fetchKalshiMarkets } from "../src/services/ingestion/kalshi.ts";

const runLive = process.env.RUN_LIVE_TESTS === "true";
const liveTest = runLive ? test : test.skip;

describe("live integrations (opt-in)", () => {
  liveTest("fetches Polymarket markets", async () => {
    const markets = await fetchPolymarketMarkets({ limit: 2 });
    if (markets.length === 0) {
      throw new Error("No Polymarket markets returned");
    }
  });

  liveTest("fetches Kalshi markets", async () => {
    const markets = await fetchKalshiMarkets({ limit: 2 });
    if (markets.length === 0) {
      throw new Error("No Kalshi markets returned");
    }
  });

  liveTest("reaches OpenAI embeddings and Qdrant", async () => {
    if (!process.env.OPENAI_API_KEY) {
      throw new Error("OPENAI_API_KEY is required for live tests");
    }

    const { generateEmbedding } = await import(
      "../src/services/embedding/openai.ts"
    );
    const { ensureCollection, getCollectionInfo, search } = await import(
      "../src/services/search/qdrant.ts"
    );

    const embedding = await generateEmbedding("live test market");
    if (embedding.length === 0) {
      throw new Error("OpenAI embedding was empty");
    }

    await ensureCollection();
    const info = await getCollectionInfo();
    if (typeof info.pointsCount !== "number") {
      throw new Error("Qdrant collection info missing pointsCount");
    }

    const results = await search(embedding, {}, 1);
    if (!Array.isArray(results)) {
      throw new Error("Qdrant search returned invalid results");
    }
  });
});
