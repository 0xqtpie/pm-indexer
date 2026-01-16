import { getEmbeddingCacheStats } from "./services/embedding/openai.ts";

export type SyncType = "incremental" | "full";
export type ExternalApiSource = "polymarket" | "kalshi";
export type ExternalApiErrorCategory =
  | "timeout"
  | "rate_limited"
  | "http_4xx"
  | "http_5xx"
  | "network"
  | "unknown";

type SyncMetrics = {
  runs: number;
  failures: number;
  lastDurationMs: number | null;
  lastError: string | null;
  lastRunAt: string | null;
};

type ExternalApiMetrics = {
  errors: number;
  categories: Record<ExternalApiErrorCategory, number>;
  lastErrorAt: string | null;
};

const syncMetrics: Record<SyncType, SyncMetrics> = {
  incremental: {
    runs: 0,
    failures: 0,
    lastDurationMs: null,
    lastError: null,
    lastRunAt: null,
  },
  full: {
    runs: 0,
    failures: 0,
    lastDurationMs: null,
    lastError: null,
    lastRunAt: null,
  },
};

const externalApiMetrics: Record<ExternalApiSource, ExternalApiMetrics> = {
  polymarket: {
    errors: 0,
    categories: {
      timeout: 0,
      rate_limited: 0,
      http_4xx: 0,
      http_5xx: 0,
      network: 0,
      unknown: 0,
    },
    lastErrorAt: null,
  },
  kalshi: {
    errors: 0,
    categories: {
      timeout: 0,
      rate_limited: 0,
      http_4xx: 0,
      http_5xx: 0,
      network: 0,
      unknown: 0,
    },
    lastErrorAt: null,
  },
};

export function recordSyncSuccess(type: SyncType, durationMs: number) {
  const entry = syncMetrics[type];
  entry.runs += 1;
  entry.lastDurationMs = durationMs;
  entry.lastRunAt = new Date().toISOString();
  entry.lastError = null;
}

export function recordSyncFailure(type: SyncType, error: string) {
  const entry = syncMetrics[type];
  entry.failures += 1;
  entry.lastError = error;
  entry.lastRunAt = new Date().toISOString();
}

export function recordExternalApiError(
  source: ExternalApiSource,
  category: ExternalApiErrorCategory
) {
  const entry = externalApiMetrics[source];
  entry.errors += 1;
  entry.categories[category] += 1;
  entry.lastErrorAt = new Date().toISOString();
}

export function getMetrics() {
  return {
    sync: syncMetrics,
    externalApis: externalApiMetrics,
    embeddingCache: getEmbeddingCacheStats(),
  };
}
