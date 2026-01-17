import { Hono } from "hono";
import type { Context, Next } from "hono";
import { cors } from "hono/cors";
import { z } from "zod";
import { createHash } from "node:crypto";
import {
  db,
  markets,
  watchlists,
  watchlistItems,
  alerts,
  alertEvents,
  marketPriceHistory,
  adminAuditLogs,
} from "../db/index.ts";
import { and, desc, eq, ilike, inArray, sql } from "drizzle-orm";
import { generateQueryEmbedding } from "../services/embedding/openai.ts";
import { recommendMarkets, search } from "../services/search/qdrant.ts";
import { getSyncStatus, SyncRunError } from "../services/sync/index.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { decodeCursor, encodeCursor } from "./pagination.ts";
import { logger } from "../logger.ts";
import { getMetrics } from "../metrics.ts";
import { getSortedPage } from "../services/search/sorted-page.ts";
import {
  triggerIncrementalSync,
  triggerFullSync,
  isSchedulerRunning,
} from "../services/scheduler/index.ts";
import { config } from "../config.ts";

const app = new Hono();

type ErrorCode =
  | "INVALID_REQUEST"
  | "INVALID_CURSOR"
  | "NOT_FOUND"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "RATE_LIMITED"
  | "UPSTREAM_FAILURE"
  | "SYNC_IN_PROGRESS"
  | "SERVICE_UNAVAILABLE"
  | "INTERNAL_ERROR";

function errorResponse(
  c: Context,
  status: number,
  code: ErrorCode,
  message: string,
  details?: unknown
) {
  return c.json(
    {
      error: {
        code,
        message,
        details,
      },
    },
    status
  );
}

function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function buildCorsOrigin(allowed: string[]) {
  if (allowed.includes("*")) {
    return "*";
  }

  if (allowed.length === 0) {
    return (origin: string | undefined) => (origin ? undefined : "*");
  }

  return (origin: string | undefined) =>
    origin && allowed.includes(origin) ? origin : undefined;
}

const MARKET_FIELD_MAP = {
  id: markets.id,
  sourceId: markets.sourceId,
  source: markets.source,
  title: markets.title,
  subtitle: markets.subtitle,
  description: markets.description,
  rules: markets.rules,
  category: markets.category,
  tags: markets.tags,
  contentHash: markets.contentHash,
  yesPrice: markets.yesPrice,
  noPrice: markets.noPrice,
  lastPrice: markets.lastPrice,
  volume: markets.volume,
  volume24h: markets.volume24h,
  liquidity: markets.liquidity,
  status: markets.status,
  result: markets.result,
  createdAt: markets.createdAt,
  openAt: markets.openAt,
  closeAt: markets.closeAt,
  expiresAt: markets.expiresAt,
  url: markets.url,
  imageUrl: markets.imageUrl,
  embeddingModel: markets.embeddingModel,
  lastSyncedAt: markets.lastSyncedAt,
};

const MARKET_FIELD_ALLOWLIST = new Set(Object.keys(MARKET_FIELD_MAP));

const SEARCH_FIELD_ALLOWLIST = new Set([
  "id",
  "source",
  "sourceId",
  "title",
  "subtitle",
  "description",
  "yesPrice",
  "noPrice",
  "volume",
  "status",
  "url",
  "tags",
  "category",
  "closeAt",
  "score",
]);

function parseFields(
  fieldParam: string | undefined,
  allowed: Set<string>
): { fields: string[] | null; error?: string } {
  if (!fieldParam) return { fields: null };
  const fields = parseList(fieldParam);
  const invalid = fields.filter((field) => !allowed.has(field));
  if (invalid.length > 0) {
    return { fields: null, error: `Invalid fields: ${invalid.join(", ")}` };
  }
  return { fields };
}

function buildMarketSelect(
  fields: string[] | null,
  extraFields: string[] = []
): { selection?: Record<string, unknown>; requested?: Set<string> } {
  if (!fields || fields.length === 0) {
    return { selection: undefined, requested: undefined };
  }

  const requested = new Set(fields);
  const selection: Record<string, unknown> = {};
  const combined = new Set([...fields, ...extraFields]);

  for (const field of combined) {
    const column = MARKET_FIELD_MAP[field as keyof typeof MARKET_FIELD_MAP];
    if (column) {
      selection[field] = column;
    }
  }

  return { selection, requested };
}

function filterFields<T extends Record<string, unknown>>(
  rows: T[],
  requested?: Set<string>
): T[] {
  if (!requested) return rows;
  return rows.map((row) => {
    const filtered: Record<string, unknown> = {};
    for (const field of requested) {
      if (field in row) {
        filtered[field] = row[field];
      }
    }
    return filtered as T;
  });
}

function getOwnerKey(c: Context): string | null {
  return c.req.header("x-user-id") ?? c.req.header("x-api-key") ?? null;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

async function logAdminAction(
  c: Context,
  action: string,
  status: "success" | "failure",
  details: Record<string, unknown> = {}
) {
  const token = resolveToken(c, "x-admin-key");
  const actor = token ? `admin:${hashToken(token)}` : undefined;

  await db.insert(adminAuditLogs).values({
    action,
    actor,
    status,
    requestIp:
      c.req.header("x-forwarded-for") ??
      c.req.header("x-real-ip") ??
      "unknown",
    userAgent: c.req.header("user-agent") ?? "unknown",
    details,
  });
}

function formatSyncResponse(result: Awaited<ReturnType<typeof triggerIncrementalSync>>) {
  return {
    status: result.status,
    success: result.status === "success",
    synced: {
      polymarket: {
        fetched: result.polymarket.fetched,
        new: result.polymarket.newMarkets,
        priceUpdates: result.polymarket.updatedPrices,
        contentChanged: result.polymarket.contentChanged,
        embeddings: result.polymarket.embeddingsGenerated,
        errors: result.polymarket.errors,
      },
      kalshi: {
        fetched: result.kalshi.fetched,
        new: result.kalshi.newMarkets,
        priceUpdates: result.kalshi.updatedPrices,
        contentChanged: result.kalshi.contentChanged,
        embeddings: result.kalshi.embeddingsGenerated,
        errors: result.kalshi.errors,
      },
      total: result.polymarket.fetched + result.kalshi.fetched,
    },
    durationMs: result.totalDurationMs,
  };
}

// Middleware
const corsOrigins = parseList(config.CORS_ORIGINS);
const adminCorsOrigins = parseList(config.ADMIN_CORS_ORIGINS);
const corsMethods = parseList(config.CORS_METHODS);
const corsHeaders = parseList(config.CORS_HEADERS);
const resolvedAdminOrigins =
  adminCorsOrigins.length > 0
    ? adminCorsOrigins.filter((origin) => origin !== "*")
    : corsOrigins.filter((origin) => origin !== "*");

app.use(
  "/*",
  cors({
    origin: buildCorsOrigin(corsOrigins),
    allowMethods: corsMethods,
    allowHeaders: corsHeaders,
  })
);

app.use(
  "/api/admin/*",
  cors({
    origin: buildCorsOrigin(resolvedAdminOrigins),
    allowMethods: corsMethods,
    allowHeaders: corsHeaders,
  })
);

function getBearerToken(c: Context): string {
  const authHeader = c.req.header("authorization") ?? "";
  return authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
}

function resolveToken(c: Context, headerName: string): string {
  const headerToken = c.req.header(headerName) ?? "";
  return headerToken || getBearerToken(c);
}

const requireAdminKey = async (c: Context, next: Next) => {
  if (!config.ADMIN_API_KEY) {
    return errorResponse(
      c,
      503,
      "SERVICE_UNAVAILABLE",
      "Admin API key not configured"
    );
  }

  const token = resolveToken(c, "x-admin-key");

  if (!token || token !== config.ADMIN_API_KEY) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Unauthorized");
  }

  await next();
};

const requireAdminCsrf = async (c: Context, next: Next) => {
  if (!config.ADMIN_CSRF_TOKEN) {
    return next();
  }

  const method = c.req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return next();
  }

  const csrfToken = c.req.header("x-csrf-token");
  if (!csrfToken || csrfToken !== config.ADMIN_CSRF_TOKEN) {
    return errorResponse(c, 403, "FORBIDDEN", "Invalid CSRF token");
  }

  return next();
};

const searchRateLimiter = createRateLimiter({
  max: config.SEARCH_RATE_LIMIT_MAX,
  windowMs: config.SEARCH_RATE_LIMIT_WINDOW_SECONDS * 1000,
  maxBuckets: config.SEARCH_RATE_LIMIT_MAX_BUCKETS,
});

const adminRateLimiter = createRateLimiter({
  max: config.ADMIN_RATE_LIMIT_MAX,
  windowMs: config.ADMIN_RATE_LIMIT_WINDOW_SECONDS * 1000,
  maxBuckets: config.ADMIN_RATE_LIMIT_MAX_BUCKETS,
});

const requireAdminRateLimit = async (c: Context, next: Next) => {
  const token = resolveToken(c, "x-admin-key");
  const key = token ? `admin:${hashToken(token)}` : getRateLimitKey(c);
  const rateLimitResult = adminRateLimiter(key);
  if (!rateLimitResult.allowed) {
    const retryAfterSeconds = Math.max(
      0,
      Math.ceil((rateLimitResult.resetAt - Date.now()) / 1000)
    );
    c.header("Retry-After", retryAfterSeconds.toString());
    return errorResponse(c, 429, "RATE_LIMITED", "Rate limit exceeded", {
      retryAfterSeconds,
    });
  }

  return next();
};

function getRateLimitKey(c: Context): string {
  const apiKey = c.req.header("x-api-key");
  if (apiKey) {
    return `key:${apiKey}`;
  }

  const authHeader = c.req.header("authorization");
  if (authHeader) {
    const hash = createHash("sha256").update(authHeader).digest("hex").slice(0, 16);
    return `auth:${hash}`;
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
app.get("/metrics", requireAdminKey, (c) => {
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
  fields: z.string().optional(),
});

// Semantic search endpoint
app.get("/api/search", async (c) => {
  const startTime = Date.now();

  try {
    const query = c.req.query();
    const parsed = searchQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const {
      q,
      limit,
      source,
      status,
      minVolume,
      cursor,
      sort,
      order,
      fields,
    } = parsed.data;

    const trimmedQuery = q.trim();
    if (trimmedQuery.length < 2) {
      return errorResponse(c, 400, "INVALID_REQUEST", "Query too short");
    }

    const parsedFields = parseFields(fields, SEARCH_FIELD_ALLOWLIST);
    if (parsedFields.error) {
      return errorResponse(c, 400, "INVALID_REQUEST", parsedFields.error);
    }

    const queryHash = createHash("sha256")
      .update(
        JSON.stringify({
          q: trimmedQuery,
          source,
          status,
          minVolume,
          sort,
          order,
        })
      )
      .digest("hex")
      .slice(0, 16);

    let offset = 0;
    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded || decoded.type !== "offset") {
        return errorResponse(c, 400, "INVALID_CURSOR", "Invalid cursor");
      }
      if (!decoded.qHash || decoded.qHash !== queryHash) {
        return errorResponse(c, 400, "INVALID_CURSOR", "Cursor does not match query");
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
      return errorResponse(c, 429, "RATE_LIMITED", "Rate limit exceeded", {
        retryAfterSeconds,
      });
    }

    // Generate embedding for query
    const queryEmbedding = await generateQueryEmbedding(trimmedQuery);
    if (queryEmbedding.length === 0) {
      return errorResponse(
        c,
        502,
        "UPSTREAM_FAILURE",
        "Failed to generate embedding"
      );
    }

    const sortWindow = Math.max(config.SEARCH_SORT_WINDOW, limit);

    if (sort !== "relevance" && offset >= sortWindow) {
      const tookMs = Date.now() - startTime;
      return c.json({
        query: trimmedQuery,
        results: [],
        meta: {
          took_ms: tookMs,
          total: 0,
          nextCursor: null,
        },
      });
    }

    // Search in Qdrant
    const searchLimit = sort === "relevance" ? limit : sortWindow;
    const searchOffset = sort === "relevance" ? offset : 0;

    const results = await search(
      queryEmbedding,
      { source, status, minVolume },
      searchLimit,
      searchOffset
    );

    const pageInfo =
      sort === "relevance"
        ? { page: results, nextOffset: offset + results.length, hasMore: results.length === limit }
        : getSortedPage(results, sort, order, limit, offset, sortWindow);

    const nextCursor = pageInfo.hasMore
      ? encodeCursor({
          type: "offset",
          offset: pageInfo.nextOffset,
          qHash: queryHash,
        })
      : null;

    const tookMs = Date.now() - startTime;

    const resultRows = pageInfo.page.map((r) => ({
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
    }));

    const requested = parsedFields.fields
      ? new Set(parsedFields.fields)
      : undefined;

    return c.json({
      query: trimmedQuery,
      results: requested ? filterFields(resultRows, requested) : resultRows,
      meta: {
        took_ms: tookMs,
        total: pageInfo.page.length,
        nextCursor,
      },
    });
  } catch (error) {
    logger.error("Search error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(c, 500, "INTERNAL_ERROR", "Search failed");
  }
});

// Get single market by ID
app.get("/api/markets/:id", async (c) => {
  const id = c.req.param("id");

  try {
    const parsedFields = parseFields(
      c.req.query("fields"),
      MARKET_FIELD_ALLOWLIST
    );
    if (parsedFields.error) {
      return errorResponse(c, 400, "INVALID_REQUEST", parsedFields.error);
    }

    const { selection, requested } = buildMarketSelect(parsedFields.fields);

    const result = await (selection
      ? db.select(selection)
      : db.select()
    )
      .from(markets)
      .where(eq(markets.id, id))
      .limit(1);

    if (result.length === 0) {
      return errorResponse(c, 404, "NOT_FOUND", "Market not found");
    }

    const row = result[0] as Record<string, unknown>;
    return c.json(requested ? filterFields([row], requested)[0] : row);
  } catch (error) {
    logger.error("Get market error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(c, 500, "INTERNAL_ERROR", "Failed to fetch market");
  }
});

// List markets query schema
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  source: z.enum(["polymarket", "kalshi"]).optional(),
  status: z.enum(["open", "closed", "settled"]).optional(),
  cursor: z.string().optional(),
  sort: z.enum(["createdAt", "closeAt", "volume", "volume24h"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  fields: z.string().optional(),
});

const suggestQuerySchema = z.object({
  q: z.string().min(2),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

const facetQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const watchlistCreateSchema = z.object({
  name: z.string().min(1).max(100),
});

const watchlistItemSchema = z.object({
  marketId: z.string().uuid(),
});

const alertCreateSchema = z.object({
  marketId: z.string().uuid(),
  type: z.enum(["price_move", "closing_soon"]),
  threshold: z.coerce.number().positive().optional(),
  windowMinutes: z.coerce.number().int().positive().optional(),
});

const alertsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

const trendQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(168).default(24),
});

const recommendQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  source: z.enum(["polymarket", "kalshi"]).optional(),
  status: z.enum(["open", "closed", "settled"]).optional(),
  minVolume: z.coerce.number().optional(),
  fields: z.string().optional(),
});

const CLOSE_AT_FUTURE = "9999-12-31T23:59:59.999Z";
const CLOSE_AT_PAST = "0001-01-01T00:00:00.000Z";

function getSortExpression(
  sort: "createdAt" | "closeAt" | "volume" | "volume24h",
  order: "asc" | "desc"
) {
  if (sort === "closeAt") {
    const sentinel =
      order === "asc"
        ? sql`${CLOSE_AT_FUTURE}::timestamp`
        : sql`${CLOSE_AT_PAST}::timestamp`;
    return sql`COALESCE(${markets.closeAt}, ${sentinel})`;
  }

  if (sort === "volume") return markets.volume;
  if (sort === "volume24h") return markets.volume24h;
  return markets.createdAt;
}

function getSortValue(
  row: Record<string, unknown>,
  sort: "createdAt" | "closeAt" | "volume" | "volume24h",
  order: "asc" | "desc"
): string | number | null {
  if (sort === "volume") {
    return Number(row.volume ?? 0);
  }
  if (sort === "volume24h") {
    return Number(row.volume24h ?? 0);
  }

  if (sort === "closeAt") {
    const raw = row.closeAt;
    if (!raw) {
      return order === "asc" ? CLOSE_AT_FUTURE : CLOSE_AT_PAST;
    }
    const dateValue = raw instanceof Date ? raw : new Date(raw as string);
    return dateValue.toISOString();
  }

  const createdAt = row.createdAt;
  const created = createdAt instanceof Date ? createdAt : new Date(createdAt as string);
  return created.toISOString();
}

// List markets endpoint
app.get("/api/markets", async (c) => {
  try {
    const queryParams = c.req.query();
    const parsed = listQuerySchema.safeParse(queryParams);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const { limit, source, status, cursor, sort, order, fields } = parsed.data;

    const parsedFields = parseFields(fields, MARKET_FIELD_ALLOWLIST);
    if (parsedFields.error) {
      return errorResponse(c, 400, "INVALID_REQUEST", parsedFields.error);
    }

    const conditions = [];
    if (source) {
      conditions.push(eq(markets.source, source));
    }
    if (status) {
      conditions.push(eq(markets.status, status));
    }

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded || decoded.type !== "keyset") {
        return errorResponse(c, 400, "INVALID_CURSOR", "Invalid cursor");
      }
      if (decoded.sort !== sort || decoded.order !== order) {
        return errorResponse(
          c,
          400,
          "INVALID_CURSOR",
          "Cursor does not match sort order"
        );
      }

      const cursorParam =
        sort === "volume" || sort === "volume24h"
          ? sql.param(Number(decoded.lastValue), markets.volume)
          : sort === "closeAt"
          ? sql.param(new Date(String(decoded.lastValue)), markets.closeAt)
          : sql.param(new Date(String(decoded.lastValue)), markets.createdAt);
      const operator = order === "asc" ? ">" : "<";
      const sortExpr = getSortExpression(sort, order);
      conditions.push(
        sql`(${sortExpr} ${sql.raw(operator)} ${cursorParam} OR (${sortExpr} = ${cursorParam} AND ${markets.id} ${sql.raw(operator)} ${sql.param(decoded.lastId, markets.id)}))`
      );
    }

    const sortExpr = getSortExpression(sort, order);
    const direction = order === "asc" ? sql.raw("ASC") : sql.raw("DESC");
    const orderBy = sql`${sortExpr} ${direction}, ${markets.id} ${direction}`;

    const extraFields = ["id", sort];
    const { selection, requested } = buildMarketSelect(parsedFields.fields, extraFields);

    const dbQuery = (selection ? db.select(selection) : db.select())
      .from(markets)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(orderBy)
      .limit(limit + 1);

    const rows = (await dbQuery) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const lastRow = page[page.length - 1];

    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({
            type: "keyset",
            sort,
            order,
            lastValue: getSortValue(lastRow, sort, order),
            lastId: String(lastRow.id),
          })
        : null;

    return c.json({
      markets: requested ? filterFields(page, requested) : page,
      meta: {
        limit,
        count: page.length,
        nextCursor,
      },
    });
  } catch (error) {
    logger.error("List markets error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(c, 500, "INTERNAL_ERROR", "Failed to list markets");
  }
});

// Search suggestions (typeahead)
app.get("/api/search/suggest", async (c) => {
  try {
    const query = c.req.query();
    const parsed = suggestQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const { q, limit } = parsed.data;
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      return errorResponse(c, 400, "INVALID_REQUEST", "Query too short");
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
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to fetch suggestions"
    );
  }
});

// Tag facets
app.get("/api/tags", async (c) => {
  try {
    const query = c.req.query();
    const parsed = facetQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const { limit } = parsed.data;
    const rows = (await db.execute(
      sql`
        SELECT tag, COUNT(*)::int AS count
        FROM ${markets}, jsonb_array_elements_text(COALESCE(${markets.tags}, '[]'::jsonb)) AS tag
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
    return errorResponse(c, 500, "INTERNAL_ERROR", "Failed to fetch tags");
  }
});

// Category facets
app.get("/api/categories", async (c) => {
  try {
    const query = c.req.query();
    const parsed = facetQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
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
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to fetch categories"
    );
  }
});

// Trending tags by 24h volume
app.get("/api/tags/trending", async (c) => {
  try {
    const query = c.req.query();
    const parsed = facetQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const { limit } = parsed.data;
    const rows = (await db.execute(
      sql`
        SELECT tag, SUM(${markets.volume24h})::float AS volume_24h
        FROM ${markets}, jsonb_array_elements_text(COALESCE(${markets.tags}, '[]'::jsonb)) AS tag
        GROUP BY tag
        ORDER BY volume_24h DESC
        LIMIT ${limit}
      `
    )) as Array<{ tag: string; volume_24h: number }>;

    return c.json({
      tags: rows,
      meta: { count: rows.length },
    });
  } catch (error) {
    logger.error("Trending tags error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to fetch trending tags"
    );
  }
});

// Trending categories by 24h volume
app.get("/api/categories/trending", async (c) => {
  try {
    const query = c.req.query();
    const parsed = facetQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const { limit } = parsed.data;
    const rows = (await db.execute(
      sql`
        SELECT category, SUM(${markets.volume24h})::float AS volume_24h
        FROM ${markets}
        WHERE ${markets.category} IS NOT NULL
        GROUP BY category
        ORDER BY volume_24h DESC
        LIMIT ${limit}
      `
    )) as Array<{ category: string; volume_24h: number }>;

    return c.json({
      categories: rows,
      meta: { count: rows.length },
    });
  } catch (error) {
    logger.error("Trending categories error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to fetch trending categories"
    );
  }
});

// Market recommendations using vector similarity
app.get("/api/markets/:id/recommendations", async (c) => {
  const marketId = c.req.param("id");

  try {
    const query = c.req.query();
    const parsed = recommendQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const { limit, source, status, minVolume, fields } = parsed.data;
    const parsedFields = parseFields(fields, SEARCH_FIELD_ALLOWLIST);
    if (parsedFields.error) {
      return errorResponse(c, 400, "INVALID_REQUEST", parsedFields.error);
    }

    const results = await recommendMarkets(
      [marketId],
      { source, status, minVolume },
      limit + 1
    );

    const filtered = results.filter((r) => r.id !== marketId).slice(0, limit);
    const rows = filtered.map((r) => ({
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
    }));

    const requested = parsedFields.fields
      ? new Set(parsedFields.fields)
      : undefined;

    return c.json({
      marketId,
      recommendations: requested ? filterFields(rows, requested) : rows,
      meta: { count: rows.length },
    });
  } catch (error) {
    logger.error("Recommendations error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to fetch recommendations"
    );
  }
});

// Market price history
app.get("/api/markets/:id/history", async (c) => {
  const marketId = c.req.param("id");

  try {
    const query = c.req.query();
    const parsed = historyQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const { limit, cursor } = parsed.data;
    const conditions = [eq(marketPriceHistory.marketId, marketId)];

    if (cursor) {
      const decoded = decodeCursor(cursor);
      if (!decoded || decoded.type !== "keyset") {
        return errorResponse(c, 400, "INVALID_CURSOR", "Invalid cursor");
      }
      if (decoded.sort !== "recordedAt" || decoded.order !== "desc") {
        return errorResponse(c, 400, "INVALID_CURSOR", "Cursor does not match sort order");
      }

      const cursorValue = sql.param(
        new Date(String(decoded.lastValue)),
        marketPriceHistory.recordedAt
      );
      conditions.push(
        sql`(${marketPriceHistory.recordedAt} < ${cursorValue} OR (${marketPriceHistory.recordedAt} = ${cursorValue} AND ${marketPriceHistory.id} < ${sql.param(decoded.lastId, marketPriceHistory.id)}))`
      );
    }

    const rows = await db
      .select()
      .from(marketPriceHistory)
      .where(and(...conditions))
      .orderBy(desc(marketPriceHistory.recordedAt), desc(marketPriceHistory.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    const lastRow = page[page.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? encodeCursor({
            type: "keyset",
            sort: "recordedAt",
            order: "desc",
            lastValue: (lastRow.recordedAt as Date).toISOString(),
            lastId: lastRow.id,
          })
        : null;

    return c.json({
      marketId,
      history: page,
      meta: { count: page.length, nextCursor },
    });
  } catch (error) {
    logger.error("Market history error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to fetch market history"
    );
  }
});

// Market price trend summary
app.get("/api/markets/:id/trend", async (c) => {
  const marketId = c.req.param("id");

  try {
    const query = c.req.query();
    const parsed = trendQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const { windowHours } = parsed.data;
    const windowMs = windowHours * 60 * 60 * 1000;
    const cutoff = sql.param(
      new Date(Date.now() - windowMs),
      marketPriceHistory.recordedAt
    );

    const latest = await db
      .select()
      .from(marketPriceHistory)
      .where(eq(marketPriceHistory.marketId, marketId))
      .orderBy(desc(marketPriceHistory.recordedAt))
      .limit(1);

    if (latest.length === 0) {
      return errorResponse(c, 404, "NOT_FOUND", "Market history not found");
    }

    const baseline = await db
      .select()
      .from(marketPriceHistory)
      .where(
        and(
          eq(marketPriceHistory.marketId, marketId),
          sql`${marketPriceHistory.recordedAt} <= ${cutoff}`
        )
      )
      .orderBy(desc(marketPriceHistory.recordedAt))
      .limit(1);

    const latestRow = latest[0];
    const baselineRow = baseline[0] ?? latestRow;
    const delta = latestRow.yesPrice - baselineRow.yesPrice;
    const percentChange =
      baselineRow.yesPrice > 0 ? delta / baselineRow.yesPrice : null;

    return c.json({
      marketId,
      windowHours,
      start: {
        recordedAt: baselineRow.recordedAt,
        yesPrice: baselineRow.yesPrice,
        noPrice: baselineRow.noPrice,
      },
      end: {
        recordedAt: latestRow.recordedAt,
        yesPrice: latestRow.yesPrice,
        noPrice: latestRow.noPrice,
      },
      delta,
      percentChange,
    });
  } catch (error) {
    logger.error("Market trend error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to fetch market trend"
    );
  }
});

// Watchlists
app.get("/api/watchlists", async (c) => {
  const ownerKey = getOwnerKey(c);
  if (!ownerKey) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Missing user identifier");
  }

  try {
    const rows = (await db.execute(
      sql`
        SELECT w.id, w.name, w.created_at, w.updated_at, COUNT(i.id)::int AS item_count
        FROM ${watchlists} AS w
        LEFT JOIN ${watchlistItems} AS i ON w.id = i.watchlist_id
        WHERE w.owner_key = ${ownerKey}
        GROUP BY w.id
        ORDER BY w.created_at DESC
      `
    )) as Array<{
      id: string;
      name: string;
      created_at: Date;
      updated_at: Date;
      item_count: number;
    }>;

    return c.json({ watchlists: rows, meta: { count: rows.length } });
  } catch (error) {
    logger.error("Watchlists error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(c, 500, "INTERNAL_ERROR", "Failed to fetch watchlists");
  }
});

app.post("/api/watchlists", async (c) => {
  const ownerKey = getOwnerKey(c);
  if (!ownerKey) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Missing user identifier");
  }

  try {
    const body = await c.req.json();
    const parsed = watchlistCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid request body",
        parsed.error.format()
      );
    }

    const [row] = await db
      .insert(watchlists)
      .values({
        ownerKey,
        name: parsed.data.name,
      })
      .returning();

    return c.json(row, 201);
  } catch (error) {
    logger.error("Create watchlist error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to create watchlist"
    );
  }
});

app.get("/api/watchlists/:id", async (c) => {
  const ownerKey = getOwnerKey(c);
  if (!ownerKey) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Missing user identifier");
  }

  const watchlistId = c.req.param("id");

  try {
    const list = await db
      .select()
      .from(watchlists)
      .where(and(eq(watchlists.id, watchlistId), eq(watchlists.ownerKey, ownerKey)))
      .limit(1);

    if (list.length === 0) {
      return errorResponse(c, 404, "NOT_FOUND", "Watchlist not found");
    }

    const items = await db
      .select({
        id: markets.id,
        title: markets.title,
        yesPrice: markets.yesPrice,
        noPrice: markets.noPrice,
        status: markets.status,
        closeAt: markets.closeAt,
        url: markets.url,
      })
      .from(watchlistItems)
      .innerJoin(markets, eq(markets.id, watchlistItems.marketId))
      .where(eq(watchlistItems.watchlistId, watchlistId))
      .orderBy(desc(watchlistItems.createdAt));

    return c.json({ watchlist: list[0], items });
  } catch (error) {
    logger.error("Watchlist detail error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(c, 500, "INTERNAL_ERROR", "Failed to fetch watchlist");
  }
});

app.post("/api/watchlists/:id/items", async (c) => {
  const ownerKey = getOwnerKey(c);
  if (!ownerKey) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Missing user identifier");
  }

  const watchlistId = c.req.param("id");

  try {
    const body = await c.req.json();
    const parsed = watchlistItemSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid request body",
        parsed.error.format()
      );
    }

    const list = await db
      .select({ id: watchlists.id })
      .from(watchlists)
      .where(and(eq(watchlists.id, watchlistId), eq(watchlists.ownerKey, ownerKey)))
      .limit(1);

    if (list.length === 0) {
      return errorResponse(c, 404, "NOT_FOUND", "Watchlist not found");
    }

    await db.insert(watchlistItems).values({
      watchlistId,
      marketId: parsed.data.marketId,
    });

    return c.json({ success: true });
  } catch (error) {
    logger.error("Add watchlist item error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to add watchlist item"
    );
  }
});

app.delete("/api/watchlists/:id/items/:marketId", async (c) => {
  const ownerKey = getOwnerKey(c);
  if (!ownerKey) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Missing user identifier");
  }

  const watchlistId = c.req.param("id");
  const marketId = c.req.param("marketId");

  try {
    const list = await db
      .select({ id: watchlists.id })
      .from(watchlists)
      .where(and(eq(watchlists.id, watchlistId), eq(watchlists.ownerKey, ownerKey)))
      .limit(1);

    if (list.length === 0) {
      return errorResponse(c, 404, "NOT_FOUND", "Watchlist not found");
    }

    await db
      .delete(watchlistItems)
      .where(and(eq(watchlistItems.watchlistId, watchlistId), eq(watchlistItems.marketId, marketId)));

    return c.json({ success: true });
  } catch (error) {
    logger.error("Remove watchlist item error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(
      c,
      500,
      "INTERNAL_ERROR",
      "Failed to remove watchlist item"
    );
  }
});

app.post("/api/watchlists/:id/alerts", async (c) => {
  const ownerKey = getOwnerKey(c);
  if (!ownerKey) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Missing user identifier");
  }

  const watchlistId = c.req.param("id");

  try {
    const body = await c.req.json();
    const parsed = alertCreateSchema.safeParse(body);
    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid request body",
        parsed.error.format()
      );
    }

    const list = await db
      .select({ id: watchlists.id })
      .from(watchlists)
      .where(and(eq(watchlists.id, watchlistId), eq(watchlists.ownerKey, ownerKey)))
      .limit(1);

    if (list.length === 0) {
      return errorResponse(c, 404, "NOT_FOUND", "Watchlist not found");
    }

    if (parsed.data.type === "price_move" && !parsed.data.threshold) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "threshold is required for price_move alerts"
      );
    }

    const windowMinutes =
      parsed.data.type === "closing_soon"
        ? parsed.data.windowMinutes ?? 60
        : undefined;

    const [row] = await db
      .insert(alerts)
      .values({
        watchlistId,
        marketId: parsed.data.marketId,
        type: parsed.data.type,
        threshold: parsed.data.threshold,
        windowMinutes,
      })
      .returning();

    return c.json(row, 201);
  } catch (error) {
    logger.error("Create alert error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(c, 500, "INTERNAL_ERROR", "Failed to create alert");
  }
});

app.get("/api/alerts", async (c) => {
  const ownerKey = getOwnerKey(c);
  if (!ownerKey) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Missing user identifier");
  }

  try {
    const query = c.req.query();
    const parsed = alertsQuerySchema.safeParse(query);

    if (!parsed.success) {
      return errorResponse(
        c,
        400,
        "INVALID_REQUEST",
        "Invalid query parameters",
        parsed.error.format()
      );
    }

    const { limit } = parsed.data;
    const rows = (await db.execute(
      sql`
        SELECT e.id, e.alert_id, e.market_id, e.triggered_at, e.payload, a.type, w.id AS watchlist_id
        FROM ${alertEvents} AS e
        INNER JOIN ${alerts} AS a ON e.alert_id = a.id
        INNER JOIN ${watchlists} AS w ON a.watchlist_id = w.id
        WHERE w.owner_key = ${ownerKey}
        ORDER BY e.triggered_at DESC
        LIMIT ${limit}
      `
    )) as Array<Record<string, unknown>>;

    return c.json({ events: rows, meta: { count: rows.length } });
  } catch (error) {
    logger.error("Alerts error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(c, 500, "INTERNAL_ERROR", "Failed to fetch alerts");
  }
});

// Admin endpoints
app.use("/api/admin/*", requireAdminKey, requireAdminRateLimit, requireAdminCsrf);

// Get sync status
app.get("/api/admin/sync/status", async (c) => {
  const status = await getSyncStatus();
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

    await logAdminAction(c, "sync.incremental", "success", {
      status: result.status,
    });

    return c.json({
      type: "incremental",
      ...formatSyncResponse(result),
    });
  } catch (error) {
    logger.error("Sync error", {
      error: error instanceof Error ? error.message : String(error),
      ...requestMeta,
    });

    if (error instanceof SyncRunError) {
      await logAdminAction(c, "sync.incremental", "failure", {
        status: error.status,
        errors: error.errors,
      });
      const httpStatus = error.status === "partial" ? 207 : 500;
      return c.json(
        {
          type: "incremental",
          ...formatSyncResponse(error.result),
        },
        httpStatus
      );
    }

    await logAdminAction(c, "sync.incremental", "failure", {
      error: error instanceof Error ? error.message : String(error),
    });

    const message = error instanceof Error ? error.message : "Sync failed";
    if (message.includes("Sync already in progress")) {
      return errorResponse(c, 409, "SYNC_IN_PROGRESS", message);
    }
    return errorResponse(c, 500, "INTERNAL_ERROR", message);
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

    await logAdminAction(c, "sync.full", "success", {
      status: result.status,
    });

    return c.json({
      type: "full",
      ...formatSyncResponse(result),
    });
  } catch (error) {
    logger.error("Full sync error", {
      error: error instanceof Error ? error.message : String(error),
      ...requestMeta,
    });

    if (error instanceof SyncRunError) {
      await logAdminAction(c, "sync.full", "failure", {
        status: error.status,
        errors: error.errors,
      });
      const httpStatus = error.status === "partial" ? 207 : 500;
      return c.json(
        {
          type: "full",
          ...formatSyncResponse(error.result),
        },
        httpStatus
      );
    }

    await logAdminAction(c, "sync.full", "failure", {
      error: error instanceof Error ? error.message : String(error),
    });

    const message = error instanceof Error ? error.message : "Full sync failed";
    if (message.includes("Sync already in progress")) {
      return errorResponse(c, 409, "SYNC_IN_PROGRESS", message);
    }
    return errorResponse(c, 500, "INTERNAL_ERROR", message);
  }
});

export default app;
