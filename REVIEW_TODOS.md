# Review To-Do List

## Data Correctness (Highest Priority)
- [ ] Fix "full sync" to include closed/settled markets (not open-only).
  - [ ] Update ingestion fetchers to support status filtering beyond open only.
    - [x] Polymarket: add configurable `closed`/`archived` options or a dedicated full-sync mode.
    - [x] Kalshi: allow fetching closed/settled markets via status filters.
  - [ ] Adjust full sync orchestration to request open+closed+settled (or all) based on mode.
  - [ ] Add tests that verify status transitions (open -> closed -> settled) are ingested.
- [ ] Ensure search payload reflects live prices/status.
  - [ ] Update Qdrant payload on every price/status change, even without re-embedding.
  - [ ] Add a fast path to refresh payload fields without re-upserting vectors.
  - [ ] Add a test that verifies price/status updates are visible via `/api/search`.
- [ ] Expand content updates beyond title/description/rules.
  - [ ] Update sync to also refresh subtitle, tags, category, closeAt, url, imageUrl.
  - [ ] Keep content hash inputs limited to title + description + rules (no tags/category/subtitle).
  - [ ] Add tests to ensure content changes trigger re-embedding when intended.

## Security and Cost Controls
- [ ] Protect all `/api/admin/*` endpoints.
  - [ ] Implement API key or JWT auth for admin routes.
  - [ ] Add audit logging for sync triggers and failures.
- [ ] Restrict CORS to known origins and allowed methods/headers.
  - [ ] Make CORS configurable via environment.
- [ ] Add rate limiting for `/api/search` to control OpenAI costs.
  - [ ] Add per-IP or per-API-key budgets.
  - [ ] Return clear error responses when limits are exceeded.

## Performance Optimizations
- [ ] Replace per-row price updates with batch SQL update.
  - [ ] Implement `UPDATE ... FROM (VALUES ...)` for price/status changes.
  - [ ] Measure and compare sync duration before/after.
- [ ] Add query embedding cache.
  - [ ] Add LRU/TTL cache for query embeddings to avoid repeat OpenAI calls.
  - [ ] Add cache metrics (hits/misses).
- [ ] Reduce DB diff read size in sync.
  - [ ] Select only required columns (id, sourceId, contentHash, status, prices).
- [ ] Add guardrails for empty embeddings and short queries.
  - [ ] Short-circuit and return a clear error or fallback results.

## API/UX Improvements
- [ ] Align `/api/markets` behavior with documented filters.
  - [ ] Implement `source` and `status` filters or remove them from schema/docs.
- [ ] Add cursor-based pagination for `/api/markets` and `/api/search`.
  - [ ] Define cursor format and add tests for pagination consistency.
- [ ] Add sorting options (volume, closeAt, createdAt).
  - [ ] Document new sort parameters and defaults.
- [ ] Add facets/metadata endpoints.
  - [ ] `/api/tags` and `/api/categories` for exploration.
  - [ ] `/api/search/suggest` for typeahead.

## Reliability and Observability
- [ ] Add structured logging with levels (honor `LOG_LEVEL`).
  - [ ] Include source, duration, and error details for sync runs.
- [ ] Add metrics for sync success/failure and external API error rate.
  - [ ] Expose a `/metrics` endpoint or integrate a metrics library.
- [ ] Add circuit breaker or retry stratification for external APIs.
  - [ ] Categorize errors (timeout vs. 4xx vs. 5xx) and handle accordingly.

## Code Quality and Tests
- [ ] Fix async normalization in `scripts/test-ingestion.ts`.
  - [ ] Await normalizer functions or use `Promise.all`.
- [ ] Deduplicate `buildEmbeddingText` implementation.
  - [ ] Keep one canonical helper and reuse it.
- [ ] Add unit tests for normalization and content hashing.
  - [ ] Validate parsing edge cases (missing prices, bad JSON, etc.).
- [ ] Add tests for sync diff logic (new, price update, content change).

## Documentation and Roadmap
- [ ] Update README and docs to reflect full sync behavior.
  - [ ] Clarify whether full sync includes closed/settled.
- [ ] Add an "Operations" section describing:
  - [ ] Rate limits and cost controls.
  - [ ] Admin auth setup.
  - [ ] Sync monitoring and alerting.
