import {
  pgTable,
  uuid,
  varchar,
  text,
  real,
  timestamp,
  pgEnum,
  jsonb,
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

export type Market = typeof markets.$inferSelect;
export type NewMarket = typeof markets.$inferInsert;
