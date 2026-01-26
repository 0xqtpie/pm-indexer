# Prediction Market Indexer

A semantic search engine for prediction markets. Ingests market data from Polymarket and Kalshi, generates embeddings via OpenRouter (supporting multiple providers), stores them in Qdrant vector database, and provides a REST API for semantic search.

Search for concepts like "cryptocurrency" and find related markets about Bitcoin, even if the exact words don't match.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        API Layer (Hono)                         │
│  GET /health  │  GET /api/search  │  GET /api/markets  │  POST /api/admin/sync  │
└─────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────┼───────────────────────────────┐
│                         Core Services                          │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │   Ingestion │  │  Embedding Svc   │  │   Search Svc     │  │
│  │   Service   │  │  (OpenRouter)    │  │   (Qdrant)       │  │
│  └─────────────┘  └──────────────────┘  └──────────────────┘  │
└───────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────┼───────────────────────────────┐
│                        Data Sources                            │
│  ┌─────────────────┐              ┌─────────────────┐         │
│  │   Polymarket    │              │     Kalshi      │         │
│  │   Gamma API     │              │   Trade API     │         │
│  └─────────────────┘              └─────────────────┘         │
└───────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────┼───────────────────────────────┐
│                         Storage                                │
│  ┌─────────────────┐              ┌─────────────────┐         │
│  │   PostgreSQL    │              │     Qdrant      │         │
│  │  (market data)  │              │  (embeddings)   │         │
│  └─────────────────┘              └─────────────────┘         │
└───────────────────────────────────────────────────────────────┘
```

## Prerequisites

- [Bun](https://bun.sh) v1.0+ (JavaScript runtime)
- [Docker](https://docker.com) & Docker Compose
- [OpenRouter API Key](https://openrouter.ai/keys)

## Quick Start

### 1. Clone and Install Dependencies

```bash
git clone <repo-url>
cd pm-indexer
bun install
```

### 2. Configure Environment

Copy the example environment file and add your OpenRouter API key:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/markets
QDRANT_URL=http://localhost:6333
OPENROUTER_API_KEY=sk-or-your-key-here  # Required!
EMBEDDING_MODEL=openai/text-embedding-3-small  # Or text-embedding-3-large
EMBEDDING_DIMENSIONS=1536  # 0 = use model default
ADMIN_API_KEY=your-admin-key     # Required for /api/admin/* and /metrics
ADMIN_CSRF_TOKEN=your-csrf-token # Optional; required for mutating admin calls if set
CORS_ORIGINS=*                   # Comma-separated list of allowed origins
ADMIN_CORS_ORIGINS=              # Optional admin CORS allowlist
SEARCH_RATE_LIMIT_MAX=60         # Requests per window for /api/search
SEARCH_RATE_LIMIT_WINDOW_SECONDS=60
SEARCH_RATE_LIMIT_MAX_BUCKETS=5000
ADMIN_RATE_LIMIT_MAX=30          # Requests per window for /api/admin/*
ADMIN_RATE_LIMIT_WINDOW_SECONDS=60
ADMIN_RATE_LIMIT_MAX_BUCKETS=2000
QUERY_EMBEDDING_CACHE_MAX_ENTRIES=1000
QUERY_EMBEDDING_CACHE_TTL_SECONDS=300
SEARCH_SORT_WINDOW=500           # Candidate window for sorted search paging
SYNC_INTERVAL_MINUTES=30
FULL_SYNC_HOUR=3
MARKET_FETCH_LIMIT=10000
ENABLE_AUTO_SYNC=false
EXCLUDE_SPORTS=true
JOB_WORKER_ENABLED=false
JOB_WORKER_POLL_MS=2000
PORT=3000
```

### 3. Start Infrastructure

Start PostgreSQL and Qdrant using Docker:

```bash
docker compose up -d db qdrant
```

Verify services are running:

```bash
docker ps
# Should show pm-indexer-db-1 and pm-indexer-qdrant-1
```

### 4. Initialize Database Schema

Generate and run migrations:

```bash
bun run db:generate
bun run db:migrate
```

### 5. Seed Data

Fetch markets from Polymarket and Kalshi, generate embeddings, and store them:

```bash
bun run scripts/seed.ts
```

This will:
- Fetch ~200 markets from each platform
- Normalize them to a common schema
- Generate embeddings via OpenRouter (default: text-embedding-3-small)
- Store vectors in Qdrant
- Save market data to PostgreSQL

### 6. Start the Server

```bash
bun run dev
```

The API will be available at `http://localhost:3000`.

## Running with Docker (Production)

Build and run everything with Docker Compose:

```bash
# Set your OpenRouter API key
export OPENROUTER_API_KEY=sk-or-your-key-here

# Build and start all services
docker compose up -d

# Check logs
docker compose logs -f app
```

This starts:
- `pm-indexer-app-1` - The API server (port 3000)
- `pm-indexer-db-1` - PostgreSQL database (port 5432)
- `pm-indexer-qdrant-1` - Qdrant vector database (port 6333)

## Intelligent Sync System

The indexer includes an intelligent sync system that minimizes API calls and embedding costs:

### Incremental Sync (Default)

- **Frequency:** Every 30 minutes (configurable via `SYNC_INTERVAL_MINUTES`)
- **Behavior:**
  - Updates prices for existing markets (no embedding cost)
  - Generates embeddings only for NEW markets
  - Re-generates embeddings only if content (title/description/rules) changed
  - When `JOB_WORKER_ENABLED=true`, embedding work is queued instead of generated inline
  - Uses content hash (SHA-256) to detect changes

### Full Sync

- **Frequency:** Daily at 3 AM (configurable via `FULL_SYNC_HOUR`)
- **Behavior:**
  - Fetches open, closed, and settled markets
  - Updates market status (open → closed → settled)
  - Same intelligent embedding logic as incremental

### Cost Optimization

For a typical sync of 10,000 markets per source:
- **Incremental sync:** Only ~10-50 new embeddings per run (~$0.001)
- **Full sync:** Similar cost, plus status updates for closed markets
- **Initial seed:** Full embedding cost (~$0.72 for 60,000 markets)

### Configuration

```bash
# .env
SYNC_INTERVAL_MINUTES=30    # Incremental sync interval
FULL_SYNC_HOUR=3            # Hour for daily full sync (0-23)
MARKET_FETCH_LIMIT=10000    # Max markets per source
ENABLE_AUTO_SYNC=true       # Enable background scheduler
JOB_WORKER_ENABLED=false    # Enqueue embedding jobs instead of inline embeddings
JOB_WORKER_POLL_MS=2000     # Job worker poll interval
```

### Manual Triggers

Admin endpoints require `ADMIN_API_KEY` via `x-admin-key` or `Authorization: Bearer`. If `ADMIN_CSRF_TOKEN` is set, include `x-csrf-token` on mutating requests.

```bash
# Incremental sync
curl -X POST http://localhost:3000/api/admin/sync \
  -H "x-admin-key: your-admin-key"

# Full sync
curl -X POST http://localhost:3000/api/admin/sync/full \
  -H "x-admin-key: your-admin-key"

# Check status
curl http://localhost:3000/api/admin/sync/status \
  -H "x-admin-key: your-admin-key"
```

## API Reference

### Errors

All error responses use a consistent envelope:

```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Invalid query parameters",
    "details": { "field": "reason" }
  }
}
```

Common error codes: `INVALID_REQUEST`, `INVALID_CURSOR`, `NOT_FOUND`, `UNAUTHORIZED`, `FORBIDDEN`, `RATE_LIMITED`, `UPSTREAM_FAILURE`, `SYNC_IN_PROGRESS`, `SERVICE_UNAVAILABLE`, `INTERNAL_ERROR`.

### Health Check

```bash
GET /health
```

Response:
```json
{
  "status": "ok",
  "timestamp": "2024-01-15T12:00:00.000Z"
}
```

### Readiness Check

Includes database and Qdrant connectivity checks:

```bash
GET /ready
```

Response (healthy):
```json
{
  "status": "healthy"
}
```

Response (unhealthy, returns 503):
```json
{
  "status": "unhealthy",
  "db": true,
  "qdrant": false
}
```

### Semantic Search

Search for markets using natural language. Uses vector similarity to find conceptually related markets.

```bash
GET /api/search?q=<query>&limit=<n>&source=<source>&status=<status>&minVolume=<volume>
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `q` | string | Yes | - | Search query (natural language) |
| `limit` | number | No | 20 | Max results (1-100) |
| `cursor` | string | No | - | Base64 cursor tied to the query and filters |
| `sort` | string | No | `relevance` | `relevance`, `volume`, or `closeAt` |
| `order` | string | No | `desc` | `asc` or `desc` |
| `source` | string | No | - | Filter: `polymarket` or `kalshi` |
| `status` | string | No | - | Filter: `open`, `closed`, or `settled` |
| `minVolume` | number | No | - | Minimum volume in USD |
| `fields` | string | No | - | Comma-separated projection of search fields |

**Cursor semantics:** `nextCursor` encodes `{ type: "offset", offset, qHash }`, where `qHash` is derived from the query + filters + sort. Passing a cursor with a different query hash returns `INVALID_CURSOR`.

For `sort != relevance`, pagination is limited to the top `SEARCH_SORT_WINDOW` matches; beyond that the API returns an empty page.

**Search field allowlist:** `id`, `source`, `sourceId`, `title`, `subtitle`, `description`, `yesPrice`, `noPrice`, `volume`, `status`, `url`, `tags`, `category`, `closeAt`, `score`.

**Examples:**

```bash
# Basic search
curl "http://localhost:3000/api/search?q=trump"

# Search with filters
curl "http://localhost:3000/api/search?q=election&source=polymarket&status=open&limit=10"

# Semantic search (finds bitcoin markets even without exact match)
curl "http://localhost:3000/api/search?q=cryptocurrency"
```

### Search Suggestions

Typeahead suggestions from market titles.

```bash
GET /api/search/suggest?q=<query>&limit=<n>
```

Response:
```json
{
  "query": "bit",
  "suggestions": ["Will Bitcoin reach $100k?", "..."],
  "meta": { "count": 10 }
}
```

### Get Single Market

```bash
GET /api/markets/:id?fields=<comma-separated>
```

`fields` is an optional projection over market columns; invalid fields return `INVALID_REQUEST`.

**Example:**

```bash
curl "http://localhost:3000/api/markets/123e4567-e89b-12d3-a456-426614174000"
```

### List Markets

```bash
GET /api/markets?limit=<n>&cursor=<cursor>&sort=<sort>&order=<order>&source=<source>&status=<status>&fields=<fields>
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | No | 20 | Max results (1-100) |
| `cursor` | string | No | - | Keyset cursor from `meta.nextCursor` |
| `sort` | string | No | `createdAt` | `createdAt`, `closeAt`, `volume`, or `volume24h` |
| `order` | string | No | `desc` | `asc` or `desc` |
| `source` | string | No | - | Filter by source |
| `status` | string | No | - | Filter by status |
| `fields` | string | No | - | Comma-separated projection of market fields |

**Cursor semantics:** keyset cursors encode `{ type: "keyset", sort, order, lastValue, lastId }` and must match the requested `sort`/`order`.

### Market Price History

```bash
GET /api/markets/:id/history?limit=<n>&cursor=<cursor>
```

Keyset paginated by `recordedAt` descending (cursor encodes `recordedAt` + `id`). Default limit is 100 (max 500).

### Market Trend Summary

```bash
GET /api/markets/:id/trend?windowHours=<n>
```

Returns start/end prices, delta, and percent change for the requested window (default 24h).

### Recommendations

```bash
GET /api/markets/:id/recommendations?limit=<n>&source=<source>&status=<status>&minVolume=<volume>&fields=<fields>
```

Returns similar markets via vector similarity. The seed market is excluded. `fields` uses the same allowlist as search.

### Tags and Categories

```bash
GET /api/tags?limit=<n>
GET /api/categories?limit=<n>
GET /api/tags/trending?limit=<n>
GET /api/categories/trending?limit=<n>
```

### Watchlists

Requires `x-user-id` or `x-api-key` header (owner key).

```bash
GET /api/watchlists
POST /api/watchlists
GET /api/watchlists/:id
POST /api/watchlists/:id/items
DELETE /api/watchlists/:id/items/:marketId
POST /api/watchlists/:id/alerts
```

Alert creation supports:
- `price_move` with `threshold` (fractional change, e.g. 0.05 = 5%).
- `closing_soon` with `windowMinutes` (default 60).

### Alerts (Events)

```bash
GET /api/alerts?limit=<n>
```

Returns recent alert events for the owner key.

### Metrics

```bash
GET /metrics
```

Requires `ADMIN_API_KEY` via `x-admin-key` or `Authorization: Bearer`.

### Sync Status

Get the current sync status and configuration:

```bash
GET /api/admin/sync/status
```

**Response:**

```json
{
  "isSyncing": false,
  "lastSyncTime": "2024-01-15T12:00:00.000Z",
  "lastFullSyncTime": "2024-01-15T03:00:00.000Z",
  "lastSyncResult": { "...": "..." },
  "schedulerRunning": true,
  "config": {
    "syncIntervalMinutes": 30,
    "fullSyncHour": 3,
    "marketFetchLimit": 10000,
    "autoSyncEnabled": true
  }
}
```

### Incremental Sync (Admin)

Trigger an incremental sync - updates prices for existing markets, generates embeddings only for new or content-changed markets:

```bash
POST /api/admin/sync
```

### Full Sync (Admin)

Trigger a full sync - includes closed/settled markets and updates status:

```bash
POST /api/admin/sync/full
```

Admin endpoints require `ADMIN_API_KEY` via `x-admin-key` or `Authorization: Bearer`. If `ADMIN_CSRF_TOKEN` is set, mutating admin requests must include `x-csrf-token`. Admin routes are rate limited via `ADMIN_RATE_LIMIT_*` and return `RATE_LIMITED` with `Retry-After` when exceeded.

## Project Structure

```
pm-indexer/
├── docker-compose.yml      # Docker services config
├── Dockerfile              # App container build
├── package.json            # Dependencies
├── tsconfig.json           # TypeScript config
├── drizzle.config.ts       # Database config
├── .env.example            # Environment template
├── src/
│   ├── index.ts            # Entry point (Bun.serve)
│   ├── config.ts           # Env validation (Zod)
│   ├── api/
│   │   ├── index.ts        # Main router (composes routes)
│   │   ├── utils.ts        # Shared utilities
│   │   ├── middleware.ts   # CORS, auth, rate limiting
│   │   ├── schemas.ts      # Zod validation schemas
│   │   └── routes/
│   │       ├── health.ts   # /health, /ready, /metrics
│   │       ├── search.ts   # /api/search, /api/suggest
│   │       ├── markets.ts  # /api/markets CRUD
│   │       ├── trending.ts # /api/tags, /api/categories
│   │       ├── watchlists.ts # /api/watchlists
│   │       ├── alerts.ts   # /api/alerts
│   │       └── admin.ts    # /api/admin/*
│   ├── db/
│   │   ├── index.ts        # Drizzle client
│   │   └── schema.ts       # Database schema
│   ├── services/
│   │   ├── embedding/
│   │   │   └── openrouter.ts # Embeddings via OpenRouter
│   │   ├── ingestion/
│   │   │   ├── polymarket.ts
│   │   │   ├── kalshi.ts
│   │   │   └── normalizer.ts
│   │   ├── jobs/
│   │   │   ├── index.ts     # Job queue helpers
│   │   │   └── worker.ts    # Background job worker
│   │   ├── search/
│   │   │   └── qdrant.ts   # Vector search
│   │   ├── sync/
│   │   │   └── index.ts    # Intelligent sync service
│   │   └── scheduler/
│   │       └── index.ts    # Background sync scheduler
│   └── types/
│       ├── market.ts       # Normalized types
│       ├── polymarket.ts   # Polymarket API types
│       └── kalshi.ts       # Kalshi API types
├── scripts/
│   ├── seed.ts             # Initial data load
│   └── test-ingestion.ts   # Test API fetching
└── tests/                  # Bun test suite
```

## Development

### Available Scripts

```bash
# Development server with hot reload
bun run dev

# Build for production
bun run build

# Type checking
bun run typecheck

# Run tests
bun test

# Database commands
bun run db:generate  # Generate migrations
bun run db:migrate   # Run migrations
```

### Testing

Run the test suite:

```bash
bun test
```

Test the ingestion manually:

```bash
bun run scripts/test-ingestion.ts
```

Notes:
- Some tests hit Postgres and expect a working `DATABASE_URL`.
- `tests/search.test.ts` and `tests/qdrant-init.test.ts` require Qdrant (and seeded vectors for the search suite).
- Opt-in live integrations are in `tests/live-integration.test.ts` and run with `RUN_LIVE_TESTS=true` (requires OpenRouter + Qdrant + network access).

### Database Management

View database contents:

```bash
# Connect to PostgreSQL
docker exec -it pm-indexer-db-1 psql -U user -d markets

# Example queries
SELECT COUNT(*) FROM markets;
SELECT title, source, yes_price FROM markets LIMIT 10;
```

### Qdrant Management

Check Qdrant collection:

```bash
# Collection info
curl http://localhost:6333/collections/markets

# Count vectors
curl http://localhost:6333/collections/markets | jq '.result.points_count'
```

Qdrant dashboard: http://localhost:6333/dashboard

## Operations

- **Rate limiting:** `/api/search` uses `SEARCH_RATE_LIMIT_*`; `/api/admin/*` uses `ADMIN_RATE_LIMIT_*` and returns `Retry-After` on 429s.
- **Admin auth:** set `ADMIN_API_KEY` and send `x-admin-key` or `Authorization: Bearer` for `/api/admin/*` and `/metrics`.
- **Admin CSRF:** if `ADMIN_CSRF_TOKEN` is set, send `x-csrf-token` for POST/PUT/PATCH/DELETE admin calls.
- **Job worker:** when `JOB_WORKER_ENABLED=true`, embedding work is enqueued and processed by the worker loop.
- **Job queue activation:** ensure migrations are applied and a process with `JOB_WORKER_ENABLED=true` is running to execute queued jobs.
- **Monitoring:** use `/metrics` and `/api/admin/sync/status` to track sync health.

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun | Fast JavaScript/TypeScript runtime |
| Web Framework | Hono | Lightweight, fast HTTP framework |
| Database | PostgreSQL | Market data storage |
| ORM | Drizzle | Type-safe database queries |
| Vector DB | Qdrant | Embedding storage & similarity search |
| Embeddings | OpenRouter | Multiple providers (default: text-embedding-3-small) |
| Validation | Zod | Runtime type validation |
| HTTP Client | ky | Fetch wrapper with retries |

## Data Sources

### Polymarket (Gamma API)

- **Base URL:** `https://gamma-api.polymarket.com`
- **Auth:** None required for read operations
- **Rate Limit:** ~100 req/min (be conservative)

### Kalshi (Trade API v2)

- **Base URL:** `https://api.elections.kalshi.com/trade-api/v2`
- **Auth:** None required for read operations
- **Rate Limit:** Undocumented (use exponential backoff)

## Troubleshooting

### "Database connection refused"

Ensure PostgreSQL is running:

```bash
docker compose up -d db
docker compose logs db
```

### "Qdrant connection error"

Ensure Qdrant is running:

```bash
docker compose up -d qdrant
curl http://localhost:6333/health
```

### "Invalid API key"

Check your `.env` file has a valid `OPENROUTER_API_KEY`.

### "No markets found"

Run the seed script to populate data:

```bash
bun run scripts/seed.ts
```

### Docker build fails

Clear Docker cache and rebuild:

```bash
docker compose build --no-cache app
```

## License

MIT
