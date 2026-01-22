import { Hono } from "hono";
import { and, eq, sql } from "drizzle-orm";
import { alertCreateSchema, alertsQuerySchema } from "../schemas.ts";
import { db, watchlists, alerts, alertEvents } from "../../db/index.ts";
import { logger } from "../../logger.ts";
import { errorResponse, getOwnerKey } from "../utils.ts";

const router = new Hono();

// List user's alert events
router.get("/alerts", async (c) => {
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

// Delete alert
router.delete("/alerts/:id", async (c) => {
  const ownerKey = getOwnerKey(c);
  if (!ownerKey) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Missing user identifier");
  }

  const alertId = c.req.param("id");

  try {
    // Verify alert belongs to user via watchlist ownership
    const alert = (await db.execute(
      sql`
        SELECT a.id
        FROM ${alerts} AS a
        INNER JOIN ${watchlists} AS w ON a.watchlist_id = w.id
        WHERE a.id = ${alertId} AND w.owner_key = ${ownerKey}
        LIMIT 1
      `
    )) as Array<{ id: string }>;

    if (alert.length === 0) {
      return errorResponse(c, 404, "NOT_FOUND", "Alert not found");
    }

    await db.delete(alerts).where(eq(alerts.id, alertId));

    return c.json({ success: true });
  } catch (error) {
    logger.error("Delete alert error", {
      error: error instanceof Error ? error.message : String(error),
    });
    return errorResponse(c, 500, "INTERNAL_ERROR", "Failed to delete alert");
  }
});

// Create alert on watchlist (mounted under /api/watchlists/:watchlistId/alerts)
export const createAlertHandler = async (c: any) => {
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
};

export default router;
