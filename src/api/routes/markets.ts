import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import {
  listQuerySchema,
  historyQuerySchema,
  trendQuerySchema,
  recommendQuerySchema,
} from "../schemas.ts";
import { db, markets, marketPriceHistory } from "../../db/index.ts";
import { recommendMarkets } from "../../services/search/qdrant.ts";
import { decodeCursor, encodeCursor } from "../pagination.ts";
import { logger } from "../../logger.ts";
import {
  errorResponse,
  parseFields,
  buildMarketSelect,
  filterFields,
  MARKET_FIELD_ALLOWLIST,
} from "../utils.ts";

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
router.get("/markets", async (c) => {
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

      // Build cursor parameter with proper type binding
      const cursorParam =
        sort === "volume" || sort === "volume24h"
          ? sql.param(Number(decoded.lastValue), markets.volume)
          : sort === "closeAt"
          ? sql.param(new Date(String(decoded.lastValue)), markets.closeAt)
          : sql.param(new Date(String(decoded.lastValue)), markets.createdAt);
      const sortExpr = getSortExpression(sort, order);
      const lastIdParam = sql.param(decoded.lastId, markets.id);
      // Keyset pagination: (sortCol > cursorVal) OR (sortCol = cursorVal AND id > lastId)
      // Note: comparison operators are from validated enum (order: "asc"|"desc"), not user input
      if (order === "asc") {
        conditions.push(
          sql`(${sortExpr} > ${cursorParam} OR (${sortExpr} = ${cursorParam} AND ${markets.id} > ${lastIdParam}))`
        );
      } else {
        conditions.push(
          sql`(${sortExpr} < ${cursorParam} OR (${sortExpr} = ${cursorParam} AND ${markets.id} < ${lastIdParam}))`
        );
      }
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

// Get single market by ID
router.get("/markets/:id", async (c) => {
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

// Market recommendations using vector similarity
router.get("/markets/:id/recommendations", async (c) => {
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
router.get("/markets/:id/history", async (c) => {
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
router.get("/markets/:id/trend", async (c) => {
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

export default router;
