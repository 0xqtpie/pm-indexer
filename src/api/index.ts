import { Hono } from "hono";
import { cors } from "hono/cors";
import { config } from "../config.ts";
import { parseList } from "./utils.ts";
import {
  buildCorsOrigin,
  requireAdminKey,
  requireAdminRateLimit,
  requireAdminCsrf,
} from "./middleware.ts";

import healthRoutes from "./routes/health.ts";
import searchRoutes from "./routes/search.ts";
import marketsRoutes from "./routes/markets.ts";
import trendingRoutes from "./routes/trending.ts";
import watchlistsRoutes from "./routes/watchlists.ts";
import alertsRoutes, { createAlertHandler } from "./routes/alerts.ts";
import adminRoutes from "./routes/admin.ts";

const app = new Hono();

// CORS configuration
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

// Mount routes
app.route("/", healthRoutes);
app.route("/api", searchRoutes);
app.route("/api", marketsRoutes);
app.route("/api", trendingRoutes);
app.route("/api", watchlistsRoutes);
app.route("/api", alertsRoutes);

// Create alert on watchlist (special case - mounted under watchlists path)
app.post("/api/watchlists/:id/alerts", createAlertHandler);

// Admin routes with middleware
app.use("/api/admin/*", requireAdminKey, requireAdminRateLimit, requireAdminCsrf);
app.route("/api/admin", adminRoutes);

export default app;
