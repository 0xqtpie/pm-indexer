# Review To-Do List

## Data Correctness (Highest Priority)
- [x] Fix `/api/search` pagination when `sort` is not `relevance`.
  - [x] Choose Option B: fixed-window re-ranking for sorted paging.
  - [x] Add `SEARCH_SORT_WINDOW` config and use it when `sort!=relevance`.
  - [x] For `sort!=relevance`, always query Qdrant with `limit=SEARCH_SORT_WINDOW` + `offset=0`, then sort + paginate in memory.
  - [x] Return an empty page (or clear error) when `cursor.offset >= SEARCH_SORT_WINDOW`.
  - [x] Add tests to ensure no duplication or skipped results across pages within the window.

## Security and Observability
- [x] Restrict `/metrics` access.
  - [x] Protect with `ADMIN_API_KEY` or a dedicated metrics key.
  - [x] Document required auth for `/metrics`.

## API/UX Improvements
- [x] Clarify search sorting semantics in docs.
  - [x] State whether `sort` is a global sort or a re-rank within relevance results.
  - [x] If re-rank only, document paging limitations or enforce them in code.

## Reliability and Data Robustness
- [x] Harden `/api/tags` against NULL `tags`.
  - [x] Use `COALESCE(tags, '[]'::jsonb)` in the SQL.
  - [x] Add a test to confirm no error when tags are null.

## Performance and Abuse Protection
- [x] Limit rate-limiter memory growth.
  - [x] Hash or truncate `Authorization` header values used in rate keys.
  - [x] Prefer API key or IP-based keys when available.
