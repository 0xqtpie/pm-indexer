import { z } from "zod";

// Search query schema for /api/search endpoint
export const searchQuerySchema = z.object({
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

// List markets query schema for /api/markets endpoint
export const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  source: z.enum(["polymarket", "kalshi"]).optional(),
  status: z.enum(["open", "closed", "settled"]).optional(),
  cursor: z.string().optional(),
  sort: z.enum(["createdAt", "closeAt", "volume", "volume24h"]).default("createdAt"),
  order: z.enum(["asc", "desc"]).default("desc"),
  fields: z.string().optional(),
});

// Suggest query schema for /api/search/suggest endpoint
export const suggestQuerySchema = z.object({
  q: z.string().min(2),
  limit: z.coerce.number().int().min(1).max(50).default(10),
});

// Facet query schema for /api/tags and /api/categories endpoints
export const facetQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Watchlist create schema for POST /api/watchlists
export const watchlistCreateSchema = z.object({
  name: z.string().min(1).max(100),
});

// Watchlist item schema for POST /api/watchlists/:id/items
export const watchlistItemSchema = z.object({
  marketId: z.string().uuid(),
});

// Alert create schema for POST /api/watchlists/:id/alerts
export const alertCreateSchema = z.object({
  marketId: z.string().uuid(),
  type: z.enum(["price_move", "closing_soon"]),
  threshold: z.coerce.number().positive().optional(),
  windowMinutes: z.coerce.number().int().positive().optional(),
});

// Alerts query schema for GET /api/alerts
export const alertsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// History query schema for /api/markets/:id/history endpoint
export const historyQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(100),
  cursor: z.string().optional(),
});

// Trend query schema for /api/markets/:id/trend endpoint
export const trendQuerySchema = z.object({
  windowHours: z.coerce.number().int().min(1).max(168).default(24),
});

// Recommend query schema for /api/markets/:id/recommendations endpoint
export const recommendQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(10),
  source: z.enum(["polymarket", "kalshi"]).optional(),
  status: z.enum(["open", "closed", "settled"]).optional(),
  minVolume: z.coerce.number().optional(),
  fields: z.string().optional(),
});

// Export inferred types for each schema
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type SuggestQuery = z.infer<typeof suggestQuerySchema>;
export type FacetQuery = z.infer<typeof facetQuerySchema>;
export type WatchlistCreate = z.infer<typeof watchlistCreateSchema>;
export type WatchlistItem = z.infer<typeof watchlistItemSchema>;
export type AlertCreate = z.infer<typeof alertCreateSchema>;
export type AlertsQuery = z.infer<typeof alertsQuerySchema>;
export type HistoryQuery = z.infer<typeof historyQuerySchema>;
export type TrendQuery = z.infer<typeof trendQuerySchema>;
export type RecommendQuery = z.infer<typeof recommendQuerySchema>;
