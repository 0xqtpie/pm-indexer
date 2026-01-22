import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { facetQuerySchema } from "../schemas.ts";
import { db, markets } from "../../db/index.ts";
import { logger } from "../../logger.ts";
import { errorResponse } from "../utils.ts";

const router = new Hono();

// Tag facets
router.get("/tags", async (c) => {
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
router.get("/categories", async (c) => {
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
router.get("/tags/trending", async (c) => {
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
router.get("/categories/trending", async (c) => {
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

export default router;
