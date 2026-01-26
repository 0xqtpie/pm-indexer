import { Hono } from "hono";
import { createHash } from "node:crypto";
import { desc, ilike } from "drizzle-orm";
import { searchQuerySchema, suggestQuerySchema } from "../schemas.ts";
import { db, markets } from "../../db/index.ts";
import { generateQueryEmbedding } from "../../services/embedding/openrouter.ts";
import { search } from "../../services/search/qdrant.ts";
import { decodeCursor, encodeCursor } from "../pagination.ts";
import { logger } from "../../logger.ts";
import { getSortedPage } from "../../services/search/sorted-page.ts";
import { config } from "../../config.ts";
import {
  errorResponse,
  parseFields,
  filterFields,
  escapeLikePattern,
} from "../utils.ts";
import { searchRateLimiter, getRateLimitKey } from "../middleware.ts";

const router = new Hono();

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

// Semantic search endpoint
router.get("/search", async (c) => {
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

// Search suggestions (typeahead)
router.get("/search/suggest", async (c) => {
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
      .where(ilike(markets.title, `%${escapeLikePattern(trimmed)}%`))
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

export default router;
