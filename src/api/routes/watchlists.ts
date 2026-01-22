import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { watchlistCreateSchema, watchlistItemSchema } from "../schemas.ts";
import { db, markets, watchlists, watchlistItems } from "../../db/index.ts";
import { logger } from "../../logger.ts";
import { errorResponse, getOwnerKey } from "../utils.ts";

const router = new Hono();

// List watchlists
router.get("/watchlists", async (c) => {
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

// Create watchlist
router.post("/watchlists", async (c) => {
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

// Get watchlist details
router.get("/watchlists/:id", async (c) => {
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

// Add market to watchlist
router.post("/watchlists/:id/items", async (c) => {
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

// Remove market from watchlist
router.delete("/watchlists/:id/items/:marketId", async (c) => {
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

export default router;
