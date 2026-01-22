import { z } from "zod";

const envSchema = z.object({
  // Database
  DATABASE_URL: z.string().url(),

  // Vector Database
  QDRANT_URL: z.string().url().default("http://localhost:6333"),

  // OpenAI
  OPENAI_API_KEY: z.string().min(1),

  // Sync settings
  SYNC_INTERVAL_MINUTES: z.coerce.number().int().positive().default(30),
  FULL_SYNC_HOUR: z.coerce.number().int().min(0).max(23).default(3),
  MARKET_FETCH_LIMIT: z.coerce.number().int().positive().default(10000),
  ENABLE_AUTO_SYNC: z.coerce.boolean().default(false),
  EXCLUDE_SPORTS: z.coerce.boolean().default(true),

  // Admin auth
  ADMIN_API_KEY: z.string().min(1).optional(),
  ADMIN_CSRF_TOKEN: z.string().min(1).optional(),
  TOKEN_FINGERPRINT_SECRET: z.string().min(16).optional(),

  // CORS
  CORS_ORIGINS: z.string().default("http://localhost:3000"),
  ADMIN_CORS_ORIGINS: z.string().default("http://localhost:3001"),
  CORS_METHODS: z.string().default("GET,POST,DELETE,OPTIONS"),
  CORS_HEADERS: z
    .string()
    .default(
      "Content-Type,Authorization,X-Admin-Key,X-API-Key,X-User-Id,X-CSRF-Token"
    ),

  // Search rate limiting
  SEARCH_RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(60),
  SEARCH_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  SEARCH_RATE_LIMIT_MAX_BUCKETS: z.coerce.number().int().positive().default(5000),
  ADMIN_RATE_LIMIT_MAX: z.coerce.number().int().nonnegative().default(30),
  ADMIN_RATE_LIMIT_WINDOW_SECONDS: z.coerce.number().int().positive().default(60),
  ADMIN_RATE_LIMIT_MAX_BUCKETS: z.coerce.number().int().positive().default(2000),
  QUERY_EMBEDDING_CACHE_MAX_ENTRIES: z.coerce.number().int().nonnegative().default(1000),
  QUERY_EMBEDDING_CACHE_TTL_SECONDS: z.coerce.number().int().nonnegative().default(300),
  SEARCH_SORT_WINDOW: z.coerce.number().int().positive().default(500),

  // Job worker
  JOB_WORKER_ENABLED: z.coerce.boolean().default(false),
  JOB_WORKER_POLL_MS: z.coerce.number().int().positive().default(2000),

  // Server
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export type Env = z.infer<typeof envSchema>;

function loadConfig(): Env {
  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    console.error("Invalid environment variables:");
    console.error(result.error.format());
    process.exit(1);
  }

  return result.data;
}

export const config = loadConfig();
