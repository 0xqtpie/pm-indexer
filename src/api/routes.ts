import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { db, markets } from "../db/index.ts";
import { and, asc, desc, eq, ilike, sql } from "drizzle-orm";
import { generateQueryEmbedding } from "../services/embedding/openai.ts";
import { search } from "../services/search/qdrant.ts";
import { getSyncStatus } from "../services/sync/index.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { decodeCursor, encodeCursor } from "./pagination.ts";
import { logger } from "../logger.ts";
import { getMetrics } from "../metrics.ts";
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

const searchRateLimiter = createRateLimiter({
  max: config.SEARCH_RATE_LIMIT_MAX,
  windowMs: config.SEARCH_RATE_LIMIT_WINDOW_SECONDS * 1000,
});

function getRateLimitKey(c: Context): string {
  const apiKey = c.req.header("x-api-key");
  if (apiKey) {
    return `key:${apiKey}`;
  }

  const authHeader = c.req.header("authorization");
  if (authHeader) {
    return `auth:${authHeader}`;
  }

  const forwardedFor = c.req.header("x-forwarded-for");
  const ip =
    forwardedFor?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    c.req.header("cf-connecting-ip") ??
    "unknown";
  return `ip:${ip}`;
}

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Metrics endpoint
app.get("/metrics", (c) => {
  return c.json(getMetrics());
});

// Search query schema
const searchQuerySchema = z.object({
  q: z.string().min(2),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  source: z.enum(["polymarket", "kalshi"]).optional(),
  status: z.enum(["open", "closed", "settled"]).optional(),
  minVolume: z.coerce.number().optional(),
  cursor: z.string().optional(),
  sort: z.enum(["relevance", "volume", "closeAt"]).default("relevance"),
  order: z.enum(["asc", "desc"]).default("desc"),
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

    const { q, limit, source, status, minVolume, cursor, sort, order } = parsed.data;

    const trimmedQuery = q.trim();
    if (trimmedQuery.length < 2) {
      return c.json({ error: "Query too short" }, 400);
    }

    let offset = 0;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return c.json({ error: "Invalid cursor" }, 400);
      }
      offset = decoded.offset;
    }

    const rateLimitKey = getRateLimitKey(c);
    const rateLimitResult = searchRateLimiter(rateLimitKey);
    if (!rateLimitResult.allowed) {
      const retryAfterSeconds = Math.max(
        0,
        Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
      );
      c.header("Retry-After", retryAfterSeconds.toString());
      return c.json(
        {
          error: "Rate limit exceeded",
          retryAfterSeconds,
        },
        429
      );
    }

    // Generate embedding for query
    const queryEmbedding = await generateQueryEmbedding(trimmedQuery);
    if (queryEmbedding.length === 0) {
      return c.json({ error: "Failed to generate embedding" }, 502);
    }

    // Search in Qdrant
    let results = await search(
      queryEmbedding,
      { source, status, minVolume },
      limit,
      offset
    );

    if (sort !== "relevance") {
      const direction = order === "asc" ? 1 : -1;
      results = results.sort((a, b) => {
        if (sort === "volume") {
          return (a.volume - b.volume) * direction;
        }
        if (sort === "closeAt") {
          const aValue = a.closeAt ?? "";
          const bValue = b.closeAt ?? "";
          if (aValue === bValue) return 0;
          return aValue < bValue ? -1 * direction : 1 * direction;
        }
        return 0;
      });
    }

    const tookMs = Date.now() - startTime;

    return c.json({
      query: trimmedQuery,
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
        closeAt: r.closeAt,
        score: r.score,
      })),
      meta: {
        took_ms: tookMs,
        total: results.length,
        nextCursor:
          results.length === limit
            ? encodeCursor({ offset: offset + results.length })
            : null,
      },
    });
  } catch (error) {
    logger.error("Search error", {
      error: error instanceof Error ? error.message : String(error),
    });
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
    logger.error("Get market error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to fetch market" }, 500);
  }
});

// List markets query schema
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
  source: z.enum(["polymarket", "kalshi"]).optional(),
  status: z.enum(["open", "closed", "settled"]).optional(),
  cursor: z.string().optional(),
  sort: z.enum(["createdAt", "closeAt", "volume", "volume24h"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
});

const suggestQuerySchema = z.object({
  q: z.string().min(2),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const facetQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
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

    const { limit, offset, source, status, cursor, sort, order } = parsed.data;

    let resolvedOffset = offset;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded) {
        return c.json({ error: "Invalid cursor" }, 400);
      }
      resolvedOffset = decoded.offset;
    }

    const conditions = [];
    if (source) {
      conditions.push(eq(markets.source, source));
    }
    if (status) {
      conditions.push(eq(markets.status, status));
    }

    const orderColumn =
      sort === "closeAt"
        ? markets.closeAt
        : sort === "volume"
        ? markets.volume
        : sort === "volume24h"
        ? markets.volume24h
        : markets.createdAt;

    const orderBy = order === "asc" ? asc(orderColumn) : desc(orderColumn);

    const query = db
      .select()
      .from(markets)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(orderBy)
      .limit(limit)
      .offset(resolvedOffset);

    const result = await query;

    return c.json({
      markets: result,
      meta: {
        limit,
        offset: resolvedOffset,
        count: result.length,
        nextCursor:
          result.length === limit
            ? encodeCursor({ offset: resolvedOffset + result.length })
            : null,
      },
    });
  } catch (error) {
    logger.error("List markets error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to list markets" }, 500);
  }
});

// Search suggestions (typeahead)
app.get("/api/search/suggest", async (c) => {
  try {
    const query = c.req.query();
    const parsed = suggestQuerySchema.safeParse(query);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.format() },
        400
      );
    }

    const { q, limit } = parsed.data;
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      return c.json({ error: "Query too short" }, 400);
    }

    const rows = await db
      .select({
        title: markets.title,
      })
      .from(markets)
      .where(ilike(markets.title, `%${trimmed}%`))
      .orderBy(desc(markets.volume))
      .limit(limit * 2);

    const suggestions: string[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
      if (seen.has(row.title)) continue;
      seen.add(row.title);
      suggestions.push(row.title);
      if (suggestions.length >= limit) break;
    }

    return c.json({
      query: trimmed,
      suggestions,
      meta: {
        count: suggestions.length,
      },
    });
  } catch (error) {
    logger.error("Suggest error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to fetch suggestions" }, 500);
  }
});

// Tag facets
app.get("/api/tags", async (c) => {
  try {
    const query = c.req.query();
    const parsed = facetQuerySchema.safeParse(query);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.format() },
        400
      );
    }

    const { limit } = parsed.data;
    const rows = (await db.execute(
      sql`
        SELECT tag, COUNT(*)::int AS count
        FROM ${markets}, jsonb_array_elements_text(${markets.tags}) AS tag
        GROUP BY tag
        ORDER BY count DESC
        LIMIT ${limit}
      `
    )) as Array<{ tag: string; count: number }>;

    return c.json({
      tags: rows,
      meta: { count: rows.length },
    });
  } catch (error) {
    logger.error("Tags error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to fetch tags" }, 500);
  }
});

// Category facets
app.get("/api/categories", async (c) => {
  try {
    const query = c.req.query();
    const parsed = facetQuerySchema.safeParse(query);

    if (!parsed.success) {
      return c.json(
        { error: "Invalid query parameters", details: parsed.error.format() },
        400
      );
    }

    const { limit } = parsed.data;
    const rows = (await db.execute(
      sql`
        SELECT category, COUNT(*)::int AS count
        FROM ${markets}
        WHERE ${markets.category} IS NOT NULL
        GROUP BY category
        ORDER BY count DESC
        LIMIT ${limit}
      `
    )) as Array<{ category: string; count: number }>;

    return c.json({
      categories: rows,
      meta: { count: rows.length },
    });
  } catch (error) {
    logger.error("Categories error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return c.json({ error: "Failed to fetch categories" }, 500);
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

  logger.info("Admin sync triggered (incremental)", requestMeta);

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
    logger.error("Sync error", {
      error: error instanceof Error ? error.message : String(error),
      ...requestMeta,
    });
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

  logger.info("Admin sync triggered (full)", requestMeta);

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
    logger.error("Full sync error", {
      error: error instanceof Error ? error.message : String(error),
      ...requestMeta,
    });
    const message = error instanceof Error ? error.message : "Full sync failed";
    return c.json({ error: message }, 500);
  }
});

export default app;
