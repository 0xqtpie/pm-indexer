import {
  pgTable,
  uuid,
  varchar,
  text,
  real,
  integer,
  boolean,
  timestamp,
  pgEnum,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const marketSourceEnum = pgEnum("market_source", [
  "polymarket",
  "kalshi",
]);

export const marketStatusEnum = pgEnum("market_status", [
  "open",
  "closed",
  "settled",
]);

export const marketResultEnum = pgEnum("market_result", ["yes", "no"]);

export const syncRunTypeEnum = pgEnum("sync_run_type", ["incremental", "full"]);
export const syncRunStatusEnum = pgEnum("sync_run_status", [
  "running",
  "success",
  "partial",
  "failed",
]);

export const jobTypeEnum = pgEnum("job_type", ["embed_market"]);
export const jobStatusEnum = pgEnum("job_status", [
  "queued",
  "processing",
  "succeeded",
  "failed",
]);

export const alertTypeEnum = pgEnum("alert_type", [
  "price_move",
  "closing_soon",
]);

export const markets = pgTable(
  "markets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    sourceId: varchar("source_id", { length: 255 }).notNull(),
    source: marketSourceEnum("source").notNull(),

    // Content
    title: text("title").notNull(),
    subtitle: text("subtitle"), // Choice label for multi-outcome markets
    description: text("description").notNull(),
    rules: text("rules"),
    category: varchar("category", { length: 255 }),
    tags: jsonb("tags").$type<string[]>().default([]),

    // Content hash for change detection (hash of title + description + rules)
    contentHash: varchar("content_hash", { length: 64 }),

    // Pricing
    yesPrice: real("yes_price").notNull(),
    noPrice: real("no_price").notNull(),
    lastPrice: real("last_price"),

    // Volume
    volume: real("volume").notNull().default(0),
    volume24h: real("volume_24h").notNull().default(0),
    liquidity: real("liquidity"),

    // Status
    status: marketStatusEnum("status").notNull().default("open"),
    result: marketResultEnum("result"),

    // Timestamps
    createdAt: timestamp("created_at").notNull().defaultNow(),
    openAt: timestamp("open_at"),
    closeAt: timestamp("close_at"),
    expiresAt: timestamp("expires_at"),

    // Metadata
    url: text("url").notNull(),
    imageUrl: text("image_url"),

    // Embedding info
    embeddingModel: varchar("embedding_model", { length: 100 }),
    lastSyncedAt: timestamp("last_synced_at").notNull().defaultNow(),
  },
  (table) => [
    // Unique index on source + sourceId for efficient upserts
    uniqueIndex("markets_source_source_id_idx").on(table.source, table.sourceId),
  ]
);

export const syncRuns = pgTable(
  "sync_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: syncRunTypeEnum("type").notNull(),
    status: syncRunStatusEnum("status").notNull().default("running"),
    startedAt: timestamp("started_at").notNull().defaultNow(),
    endedAt: timestamp("ended_at"),
    durationMs: integer("duration_ms"),
    result: jsonb("result").$type<unknown>(),
    errors: jsonb("errors").$type<string[]>().default([]),
  },
  (table) => [
    index("sync_runs_status_idx").on(table.status),
    index("sync_runs_type_started_at_idx").on(table.type, table.startedAt),
  ]
);

export const jobs = pgTable(
  "jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    type: jobTypeEnum("type").notNull(),
    status: jobStatusEnum("status").notNull().default("queued"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: timestamp("run_at").notNull().defaultNow(),
    lockedAt: timestamp("locked_at"),
    lockedBy: varchar("locked_by", { length: 100 }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("jobs_status_run_at_idx").on(table.status, table.runAt),
  ]
);

export const adminAuditLogs = pgTable(
  "admin_audit_logs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    action: varchar("action", { length: 100 }).notNull(),
    actor: varchar("actor", { length: 100 }),
    status: varchar("status", { length: 32 }).notNull(),
    requestIp: varchar("request_ip", { length: 100 }),
    userAgent: text("user_agent"),
    details: jsonb("details").$type<Record<string, unknown>>().default({}),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [index("admin_audit_logs_action_idx").on(table.action)]
);

export const watchlists = pgTable(
  "watchlists",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    ownerKey: varchar("owner_key", { length: 255 }).notNull(),
    name: text("name").notNull(),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("watchlists_owner_name_idx").on(table.ownerKey, table.name),
  ]
);

export const watchlistItems = pgTable(
  "watchlist_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchlistId: uuid("watchlist_id")
      .notNull()
      .references(() => watchlists.id, { onDelete: "cascade" }),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("watchlist_items_unique_idx").on(
      table.watchlistId,
      table.marketId
    ),
  ]
);

export const alerts = pgTable(
  "alerts",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    watchlistId: uuid("watchlist_id")
      .notNull()
      .references(() => watchlists.id, { onDelete: "cascade" }),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    type: alertTypeEnum("type").notNull(),
    threshold: real("threshold"),
    windowMinutes: integer("window_minutes"),
    enabled: boolean("enabled").notNull().default(true),
    lastTriggeredAt: timestamp("last_triggered_at"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (table) => [
    index("alerts_watchlist_idx").on(table.watchlistId),
    index("alerts_market_idx").on(table.marketId),
  ]
);

export const alertEvents = pgTable(
  "alert_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    alertId: uuid("alert_id")
      .notNull()
      .references(() => alerts.id, { onDelete: "cascade" }),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    triggeredAt: timestamp("triggered_at").notNull().defaultNow(),
    payload: jsonb("payload").$type<Record<string, unknown>>().default({}),
  },
  (table) => [index("alert_events_market_idx").on(table.marketId)]
);

export const marketPriceHistory = pgTable(
  "market_price_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    marketId: uuid("market_id")
      .notNull()
      .references(() => markets.id, { onDelete: "cascade" }),
    yesPrice: real("yes_price").notNull(),
    noPrice: real("no_price").notNull(),
    volume: real("volume").notNull().default(0),
    volume24h: real("volume_24h").notNull().default(0),
    status: marketStatusEnum("status").notNull(),
    recordedAt: timestamp("recorded_at").notNull().defaultNow(),
  },
  (table) => [
    index("market_price_history_market_idx").on(
      table.marketId,
      table.recordedAt
    ),
  ]
);

export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
export type SyncRun = typeof syncRuns.$inferSelect;
export type NewSyncRun = typeof syncRuns.$inferInsert;
export type Job = typeof jobs.$inferSelect;
export type NewJob = typeof jobs.$inferInsert;
export type AdminAuditLog = typeof adminAuditLogs.$inferSelect;
export type NewAdminAuditLog = typeof adminAuditLogs.$inferInsert;
export type Watchlist = typeof watchlists.$inferSelect;
export type NewWatchlist = typeof watchlists.$inferInsert;
export type WatchlistItem = typeof watchlistItems.$inferSelect;
export type NewWatchlistItem = typeof watchlistItems.$inferInsert;
export type Alert = typeof alerts.$inferSelect;
export type NewAlert = typeof alerts.$inferInsert;
export type AlertEvent = typeof alertEvents.$inferSelect;
export type NewAlertEvent = typeof alertEvents.$inferInsert;
export type MarketPriceHistory = typeof marketPriceHistory.$inferSelect;
export type NewMarketPriceHistory = typeof marketPriceHistory.$inferInsert;
