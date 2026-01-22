import type { Context, Next } from "hono";
import { createHash } from "node:crypto";
import { db, adminAuditLogs } from "../db/index.ts";
import { config } from "../config.ts";
import { createRateLimiter } from "./rate-limit.ts";
import { errorResponse, parseList, tokenFingerprint } from "./utils.ts";

export function buildCorsOrigin(allowed: string[]) {
  if (allowed.includes("*")) {
    return "*";
  }

  if (allowed.length === 0) {
    return (origin: string | undefined) => (origin ? undefined : "*");
  }

  return (origin: string | undefined) =>
    origin && allowed.includes(origin) ? origin : undefined;
}

export const searchRateLimiter = createRateLimiter({
  max: config.SEARCH_RATE_LIMIT_MAX,
  windowMs: config.SEARCH_RATE_LIMIT_WINDOW_SECONDS * 1000,
  maxBuckets: config.SEARCH_RATE_LIMIT_MAX_BUCKETS,
});

export const adminRateLimiter = createRateLimiter({
  max: config.ADMIN_RATE_LIMIT_MAX,
  windowMs: config.ADMIN_RATE_LIMIT_WINDOW_SECONDS * 1000,
  maxBuckets: config.ADMIN_RATE_LIMIT_MAX_BUCKETS,
});

export function getBearerToken(c: Context): string {
  const authHeader = c.req.header("authorization") ?? "";
  return authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";
}

export function resolveToken(c: Context, headerName: string): string {
  const headerToken = c.req.header(headerName) ?? "";
  return headerToken || getBearerToken(c);
}

export const requireAdminKey = async (c: Context, next: Next) => {
  if (!config.ADMIN_API_KEY) {
    return errorResponse(
      c,
      503,
      "SERVICE_UNAVAILABLE",
      "Admin API key not configured"
    );
  }

  const token = resolveToken(c, "x-admin-key");

  if (!token || token !== config.ADMIN_API_KEY) {
    return errorResponse(c, 401, "UNAUTHORIZED", "Unauthorized");
  }

  await next();
};

export const requireAdminCsrf = async (c: Context, next: Next) => {
  if (!config.ADMIN_CSRF_TOKEN) {
    return next();
  }

  const method = c.req.method.toUpperCase();
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
    return next();
  }

  const csrfToken = c.req.header("x-csrf-token");
  if (!csrfToken || csrfToken !== config.ADMIN_CSRF_TOKEN) {
    return errorResponse(c, 403, "FORBIDDEN", "Invalid CSRF token");
  }

  return next();
};

export function getRateLimitKey(c: Context): string {
  const apiKey = c.req.header("x-api-key");
  if (apiKey) {
    return `key:${apiKey}`;
  }

  const authHeader = c.req.header("authorization");
  if (authHeader) {
    const hash = createHash("sha256").update(authHeader).digest("hex").slice(0, 16);
    return `auth:${hash}`;
  }

  const forwardedFor = c.req.header("x-forwarded-for");
  const ip =
    forwardedFor?.split(",")[0]?.trim() ??
    c.req.header("x-real-ip") ??
    c.req.header("cf-connecting-ip") ??
    "unknown";
  return `ip:${ip}`;
}

export const requireAdminRateLimit = async (c: Context, next: Next) => {
  const token = resolveToken(c, "x-admin-key");
  const key = token ? `admin:${tokenFingerprint(token)}` : getRateLimitKey(c);
  const rateLimitResult = adminRateLimiter(key);
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

  return next();
};

export async function logAdminAction(
  c: Context,
  action: string,
  status: "success" | "failure",
  details: Record<string, unknown> = {}
) {
  const token = resolveToken(c, "x-admin-key");
  const actor = token ? `admin:${tokenFingerprint(token)}` : undefined;

  await db.insert(adminAuditLogs).values({
    action,
    actor,
    status,
    requestIp:
      c.req.header("x-forwarded-for") ??
      c.req.header("x-real-ip") ??
      "unknown",
    userAgent: c.req.header("user-agent") ?? "unknown",
    details,
  });
}
