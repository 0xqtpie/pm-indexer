# Review To-Do List

## Data Correctness (Highest Priority)
- [x] Fix "full sync" to include closed/settled markets (not open-only).
  - [x] Update ingestion fetchers to support status filtering beyond open only.
    - [x] Polymarket: add configurable `closed`/`archived` options or a dedicated full-sync mode.
    - [x] Kalshi: allow fetching closed/settled markets via status filters.
  - [x] Adjust full sync orchestration to request open+closed+settled (or all) based on mode.
  - [x] Add tests that verify status transitions (open -> closed -> settled) are ingested.
- [x] Ensure search payload reflects live prices/status.
  - [x] Update Qdrant payload on every price/status change, even without re-embedding.
  - [x] Add a fast path to refresh payload fields without re-upserting vectors.
  - [x] Add a test that verifies price/status updates are visible via `/api/search`.
- [x] Expand content updates beyond title/description/rules.
  - [x] Update sync to also refresh subtitle, tags, category, closeAt, url, imageUrl.
  - [x] Keep content hash inputs limited to title + description + rules (no tags/category/subtitle).
  - [x] Add tests to ensure content changes trigger re-embedding when intended.

## Security and Cost Controls
- [x] Protect all `/api/admin/*` endpoints.
  - [x] Implement API key or JWT auth for admin routes.
  - [x] Add audit logging for sync triggers and failures.
- [x] Restrict CORS to known origins and allowed methods/headers.
  - [x] Make CORS configurable via environment.
- [x] Add rate limiting for `/api/search` to control OpenAI costs.
  - [x] Add per-IP or per-API-key budgets.
  - [x] Return clear error responses when limits are exceeded.

## Performance Optimizations
- [x] Replace per-row price updates with batch SQL update.
  - [x] Implement `UPDATE ... FROM (VALUES ...)` for price/status changes.
  - [x] Measure and compare sync duration before/after.
- [x] Add query embedding cache.
  - [x] Add LRU/TTL cache for query embeddings to avoid repeat OpenAI calls.
  - [x] Add cache metrics (hits/misses).
- [x] Reduce DB diff read size in sync.
  - [x] Select only required columns (id, sourceId, contentHash, status, prices).
- [x] Add guardrails for empty embeddings and short queries.
  - [x] Short-circuit and return a clear error or fallback results.

## API/UX Improvements
- [x] Align `/api/markets` behavior with documented filters.
  - [x] Implement `source` and `status` filters or remove them from schema/docs.
- [x] Add cursor-based pagination for `/api/markets` and `/api/search`.
  - [x] Define cursor format and add tests for pagination consistency.
- [x] Add sorting options (volume, closeAt, createdAt).
  - [x] Document new sort parameters and defaults.
- [x] Add facets/metadata endpoints.
  - [x] `/api/tags` and `/api/categories` for exploration.
  - [x] `/api/search/suggest` for typeahead.

## Reliability and Observability
- [x] Add structured logging with levels (honor `LOG_LEVEL`).
  - [x] Include source, duration, and error details for sync runs.
- [x] Add metrics for sync success/failure and external API error rate.
  - [x] Expose a `/metrics` endpoint or integrate a metrics library.
- [x] Add circuit breaker or retry stratification for external APIs.
  - [x] Categorize errors (timeout vs. 4xx vs. 5xx) and handle accordingly.

## Code Quality and Tests
- [x] Fix async normalization in `scripts/test-ingestion.ts`.
  - [x] Await normalizer functions or use `Promise.all`.
- [x] Deduplicate `buildEmbeddingText` implementation.
  - [x] Keep one canonical helper and reuse it.
- [x] Add unit tests for normalization and content hashing.
  - [x] Validate parsing edge cases (missing prices, bad JSON, etc.).
- [x] Add tests for sync diff logic (new, price update, content change).

## Documentation and Roadmap
- [x] Update README and docs to reflect full sync behavior.
  - [x] Clarify whether full sync includes closed/settled.
- [x] Add an "Operations" section describing:
  - [x] Rate limits and cost controls.
  - [x] Admin auth setup.
  - [x] Sync monitoring and alerting.
