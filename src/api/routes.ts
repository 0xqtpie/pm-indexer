import { Hono } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { db, markets } from "../db/index.ts";
import { eq } from "drizzle-orm";
import { generateEmbedding } from "../services/embedding/openai.ts";
import { search, ensureCollection } from "../services/search/qdrant.ts";
import { fetchPolymarketMarkets } from "../services/ingestion/polymarket.ts";
import { fetchKalshiMarkets } from "../services/ingestion/kalshi.ts";
import {
  normalizePolymarketMarket,
  normalizeKalshiMarket,
} from "../services/ingestion/normalizer.ts";
import {
  generateMarketEmbeddings,
  EMBEDDING_MODEL,
} from "../services/embedding/openai.ts";
import { upsertMarkets } from "../services/search/qdrant.ts";
import type { NewMarket } from "../db/schema.ts";

const app = new Hono();

// Middleware
app.use("/*", cors());

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Search query schema
const searchQuerySchema = z.object({
  q: z.string().min(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  source: z.enum(["polymarket", "kalshi"]).optional(),
  status: z.enum(["open", "closed", "settled"]).optional(),
  minVolume: z.coerce.number().optional(),
});

// Semantic search endpoint
app.get("/api/search", async (c) => {
  const startTime = Date.now();

  try {
    const query = c.req.query();
    const parsed = searchQuerySchema.safeParse(query);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.format() },
        400
      );
    }

    const { q, limit, source, status, minVolume } = parsed.data;

    // Generate embedding for query
    const queryEmbedding = await generateEmbedding(q);

    // Search in Qdrant
    const results = await search(
      queryEmbedding,
      { source, status, minVolume },
      limit
    );

    const tookMs = Date.now() - startTime;

    return c.json({
      query: q,
      results: results.map((r) => ({
        id: r.id,
        source: r.source,
        sourceId: r.sourceId,
        title: r.title,
        description: r.description,
        yesPrice: r.yesPrice,
        noPrice: r.noPrice,
        volume: r.volume,
        status: r.status,
        url: r.url,
        tags: r.tags,
        category: r.category,
        score: r.score,
      })),
      meta: {
        took_ms: tookMs,
        total: results.length,
      },
    });
  } catch (error) {
    console.error("Search error:", error);
    return c.json({ error: "Search failed" }, 500);
  }
});

// Get single market by ID
app.get("/api/markets/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const result = await db
      .select()
      .from(markets)
      .where(eq(markets.id, id))
      .limit(1);

    if (result.length === 0) {
      return c.json({ error: "Market not found" }, 404);
    }

    return c.json(result[0]);
  } catch (error) {
    console.error("Get market error:", error);
    return c.json({ error: "Failed to fetch market" }, 500);
  }
});

// List markets query schema
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  source: z.enum(["polymarket", "kalshi"]).optional(),
  status: z.enum(["open", "closed", "settled"]).optional(),
});

// List markets endpoint
app.get("/api/markets", async (c) => {
  try {
    const query = c.req.query();
    const parsed = listQuerySchema.safeParse(query);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.format() },
        400
      );
    }

    const { limit, offset } = parsed.data;

    const result = await db.select().from(markets).limit(limit).offset(offset);

    return c.json({
      markets: result,
      meta: {
        limit,
        offset,
        count: result.length,
      },
    });
  } catch (error) {
    console.error("List markets error:", error);
    return c.json({ error: "Failed to list markets" }, 500);
  }
});

// Admin sync endpoint
app.post("/api/admin/sync", async (c) => {
  try {
    console.log("Starting sync...");

    // Fetch markets
    const [polymarketRaw, kalshiRaw] = await Promise.all([
      fetchPolymarketMarkets({ limit: 200 }),
      fetchKalshiMarkets({ limit: 200 }),
    ]);

    // Normalize
    const normalizedMarkets = [
      ...polymarketRaw.map(normalizePolymarketMarket),
      ...kalshiRaw.map(normalizeKalshiMarket),
    ];

    // Generate embeddings
    const embeddings = await generateMarketEmbeddings(normalizedMarkets);

    // Ensure collection exists
    await ensureCollection();

    // Upsert to Qdrant
    await upsertMarkets(normalizedMarkets, embeddings);

    // Save to Postgres
    const dbRecords: NewMarket[] = normalizedMarkets.map((m) => ({
      id: m.id,
      sourceId: m.sourceId,
      source: m.source,
      title: m.title,
      description: m.description,
      rules: m.rules,
      category: m.category,
      tags: m.tags,
      yesPrice: m.yesPrice,
      noPrice: m.noPrice,
      lastPrice: m.lastPrice,
      volume: m.volume,
      volume24h: m.volume24h,
      liquidity: m.liquidity,
      status: m.status,
      result: m.result,
      createdAt: m.createdAt,
      openAt: m.openAt,
      closeAt: m.closeAt,
      expiresAt: m.expiresAt,
      url: m.url,
      imageUrl: m.imageUrl,
      embeddingModel: EMBEDDING_MODEL,
      lastSyncedAt: m.lastSyncedAt,
    }));

    for (const record of dbRecords) {
      await db
        .insert(markets)
        .values(record)
        .onConflictDoUpdate({
          target: markets.id,
          set: {
            title: record.title,
            description: record.description,
            yesPrice: record.yesPrice,
            noPrice: record.noPrice,
            volume: record.volume,
            volume24h: record.volume24h,
            status: record.status,
            lastSyncedAt: new Date(),
          },
        });
    }

    return c.json({
      success: true,
      synced: {
        polymarket: polymarketRaw.length,
        kalshi: kalshiRaw.length,
        total: normalizedMarkets.length,
      },
    });
  } catch (error) {
    console.error("Sync error:", error);
    return c.json({ error: "Sync failed" }, 500);
  }
});

export default app;
