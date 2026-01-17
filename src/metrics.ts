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
  partials: number;
  lastDurationMs: number | null;
  lastError: string | null;
  lastRunAt: string | null;
  lastStatus: "success" | "partial" | "failed" | null;
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
    partials: 0,
    lastDurationMs: null,
    lastError: null,
    lastRunAt: null,
    lastStatus: null,
  },
  full: {
    runs: 0,
    failures: 0,
    partials: 0,
    lastDurationMs: null,
    lastError: null,
    lastRunAt: null,
    lastStatus: null,
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
  entry.lastStatus = "success";
}

export function recordSyncPartial(
  type: SyncType,
  error: string,
  durationMs?: number
) {
  const entry = syncMetrics[type];
  entry.runs += 1;
  entry.partials += 1;
  entry.lastError = error;
  entry.lastRunAt = new Date().toISOString();
  entry.lastDurationMs = durationMs ?? entry.lastDurationMs;
  entry.lastStatus = "partial";
}

export function recordSyncFailure(type: SyncType, error: string) {
  const entry = syncMetrics[type];
  entry.runs += 1;
  entry.failures += 1;
  entry.lastError = error;
  entry.lastRunAt = new Date().toISOString();
  entry.lastStatus = "failed";
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
