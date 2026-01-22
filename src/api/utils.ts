import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createHmac } from "node:crypto";
import { markets } from "../db/index.ts";
import { config } from "../config.ts";

export type ErrorCode =
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

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
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

export function parseList(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
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

export const MARKET_FIELD_ALLOWLIST = new Set(Object.keys(MARKET_FIELD_MAP));

export function parseFields(
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

export function buildMarketSelect(
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

export function filterFields<T extends Record<string, unknown>>(
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

export function getOwnerKey(c: Context): string | null {
  return c.req.header("x-user-id") ?? c.req.header("x-api-key") ?? null;
}

/**
 * Escape LIKE/ILIKE special characters to prevent unexpected query behavior.
 * Characters %, _, and \ have special meaning in SQL LIKE patterns.
 */
export function escapeLikePattern(input: string): string {
  return input
    .replace(/\\/g, "\\\\") // Escape backslash first
    .replace(/%/g, "\\%")
    .replace(/_/g, "\\_");
}

/**
 * Generate a stable fingerprint for audit logging purposes.
 * Uses HMAC with a server secret to prevent rainbow table attacks.
 */
export function tokenFingerprint(token: string): string {
  const secret = config.TOKEN_FINGERPRINT_SECRET ?? "pm-indexer-default-secret";
  return createHmac("sha256", secret).update(token).digest("hex").slice(0, 16);
}
