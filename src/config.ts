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
