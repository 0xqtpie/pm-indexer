import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { db, markets } from "../db/index.ts";
import { eq } from "drizzle-orm";
import { generateEmbedding } from "../services/embedding/openai.ts";
import { search } from "../services/search/qdrant.ts";
import { getSyncStatus } from "../services/sync/index.ts";
import {
  triggerIncrementalSync,
  triggerFullSync,
  isSchedulerRunning,
} from "../services/scheduler/index.ts";
import { config } from "../config.ts";

const app = new Hono();

// Middleware
const corsOrigins = config.CORS_ORIGINS.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);
const corsMethods = config.CORS_METHODS.split(",")
  .map((method) => method.trim())
  .filter(Boolean);
const corsHeaders = config.CORS_HEADERS.split(",")
  .map((header) => header.trim())
  .filter(Boolean);

app.use(
  "/*",
  cors({
    origin: corsOrigins.includes("*") || corsOrigins.length === 0 ? "*" : corsOrigins,
    allowMethods: corsMethods,
    allowHeaders: corsHeaders,
  })
);

const requireAdminKey = async (c: Context, next: Next) => {
  if (!config.ADMIN_API_KEY) {
    return c.json({ error: "Admin API key not configured" }, 503);
  }

  const authHeader = c.req.header("authorization") ?? "";
  const bearerToken = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
  const headerToken = c.req.header("x-admin-key") ?? "";
  const token = bearerToken || headerToken;

  if (!token || token !== config.ADMIN_API_KEY) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
};

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
        subtitle: r.subtitle,
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

// Get sync status
app.use("/api/admin/*", requireAdminKey);

// Get sync status
app.get("/api/admin/sync/status", (c) => {
  const status = getSyncStatus();
  return c.json({
    ...status,
    schedulerRunning: isSchedulerRunning(),
    config: {
      syncIntervalMinutes: config.SYNC_INTERVAL_MINUTES,
      fullSyncHour: config.FULL_SYNC_HOUR,
      marketFetchLimit: config.MARKET_FETCH_LIMIT,
      autoSyncEnabled: config.ENABLE_AUTO_SYNC,
    },
  });
});

// Trigger incremental sync (updates prices, only embeds new/changed markets)
app.post("/api/admin/sync", async (c) => {
  const requestMeta = {
    ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
    userAgent: c.req.header("user-agent") ?? "unknown",
  };

  console.log("Admin sync triggered (incremental)", requestMeta);

  try {
    const result = await triggerIncrementalSync();

    return c.json({
      success: true,
      type: "incremental",
      synced: {
        polymarket: {
          fetched: result.polymarket.fetched,
          new: result.polymarket.newMarkets,
          priceUpdates: result.polymarket.updatedPrices,
          contentChanged: result.polymarket.contentChanged,
          embeddings: result.polymarket.embeddingsGenerated,
        },
        kalshi: {
          fetched: result.kalshi.fetched,
          new: result.kalshi.newMarkets,
          priceUpdates: result.kalshi.updatedPrices,
          contentChanged: result.kalshi.contentChanged,
          embeddings: result.kalshi.embeddingsGenerated,
        },
        total: result.polymarket.fetched + result.kalshi.fetched,
      },
      durationMs: result.totalDurationMs,
    });
  } catch (error) {
    console.error("Sync error:", { error, ...requestMeta });
    const message = error instanceof Error ? error.message : "Sync failed";
    return c.json({ error: message }, 500);
  }
});

// Trigger full sync (includes closed markets, updates status)
app.post("/api/admin/sync/full", async (c) => {
  const requestMeta = {
    ip: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown",
    userAgent: c.req.header("user-agent") ?? "unknown",
  };

  console.log("Admin sync triggered (full)", requestMeta);

  try {
    const result = await triggerFullSync();

    return c.json({
      success: true,
      type: "full",
      synced: {
        polymarket: {
          fetched: result.polymarket.fetched,
          new: result.polymarket.newMarkets,
          priceUpdates: result.polymarket.updatedPrices,
          contentChanged: result.polymarket.contentChanged,
          embeddings: result.polymarket.embeddingsGenerated,
        },
        kalshi: {
          fetched: result.kalshi.fetched,
          new: result.kalshi.newMarkets,
          priceUpdates: result.kalshi.updatedPrices,
          contentChanged: result.kalshi.contentChanged,
          embeddings: result.kalshi.embeddingsGenerated,
        },
        total: result.polymarket.fetched + result.kalshi.fetched,
      },
      durationMs: result.totalDurationMs,
    });
  } catch (error) {
    console.error("Full sync error:", { error, ...requestMeta });
    const message = error instanceof Error ? error.message : "Full sync failed";
    return c.json({ error: message }, 500);
  }
});

export default app;
