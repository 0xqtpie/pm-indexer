# Prediction Market Indexer

A semantic search engine for prediction markets. Ingests market data from Polymarket and Kalshi, generates embeddings using OpenAI, stores them in Qdrant vector database, and provides a REST API for semantic search.

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
│  │   Service   │  │  (OpenAI)        │  │   (Qdrant)       │  │
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
- [OpenAI API Key](https://platform.openai.com/api-keys)

## Quick Start

### 1. Clone and Install Dependencies

```bash
git clone <repo-url>
cd pm-indexer
bun install
```

### 2. Configure Environment

Copy the example environment file and add your OpenAI API key:

```bash
cp .env.example .env
```

Edit `.env`:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/markets
QDRANT_URL=http://localhost:6333
OPENAI_API_KEY=sk-your-key-here  # Required!
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

Push the database schema to PostgreSQL:

```bash
bun run db:push
```

### 5. Seed Data

Fetch markets from Polymarket and Kalshi, generate embeddings, and store them:

```bash
bun run scripts/seed.ts
```

This will:
- Fetch ~200 markets from each platform
- Normalize them to a common schema
- Generate OpenAI embeddings (text-embedding-3-small)
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
# Set your OpenAI API key
export OPENAI_API_KEY=sk-your-key-here

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
  - Uses content hash (SHA-256) to detect changes

### Full Sync

- **Frequency:** Daily at 3 AM (configurable via `FULL_SYNC_HOUR`)
- **Behavior:**
  - Fetches all markets including closed/settled
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
```

### Manual Triggers

```bash
# Incremental sync
curl -X POST http://localhost:3000/api/admin/sync

# Full sync
curl -X POST http://localhost:3000/api/admin/sync/full

# Check status
curl http://localhost:3000/api/admin/sync/status
```

## API Reference

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
| `source` | string | No | - | Filter: `polymarket` or `kalshi` |
| `status` | string | No | - | Filter: `open`, `closed`, or `settled` |
| `minVolume` | number | No | - | Minimum volume in USD |

**Examples:**

```bash
# Basic search
curl "http://localhost:3000/api/search?q=trump"

# Search with filters
curl "http://localhost:3000/api/search?q=election&source=polymarket&status=open&limit=10"

# Semantic search (finds bitcoin markets even without exact match)
curl "http://localhost:3000/api/search?q=cryptocurrency"
```

**Response:**

```json
{
  "query": "trump",
  "results": [
    {
      "id": "uuid",
      "source": "polymarket",
      "sourceId": "original-id",
      "title": "Will Trump win the 2024 election?",
      "description": "...",
      "yesPrice": 0.55,
      "noPrice": 0.45,
      "volume": 1500000,
      "status": "open",
      "url": "https://polymarket.com/...",
      "tags": ["politics", "election"],
      "category": "Politics",
      "score": 0.89
    }
  ],
  "meta": {
    "took_ms": 45,
    "total": 20
  }
}
```

### Get Single Market

```bash
GET /api/markets/:id
```

**Example:**

```bash
curl "http://localhost:3000/api/markets/123e4567-e89b-12d3-a456-426614174000"
```

**Response:**

```json
{
  "id": "123e4567-e89b-12d3-a456-426614174000",
  "sourceId": "original-platform-id",
  "source": "polymarket",
  "title": "Will Bitcoin reach $100k?",
  "description": "...",
  "rules": "Resolution rules...",
  "category": "Crypto",
  "tags": ["bitcoin", "crypto"],
  "yesPrice": 0.65,
  "noPrice": 0.35,
  "volume": 500000,
  "volume24h": 25000,
  "liquidity": 100000,
  "status": "open",
  "createdAt": "2024-01-01T00:00:00.000Z",
  "closeAt": "2024-12-31T00:00:00.000Z",
  "url": "https://polymarket.com/...",
  "embeddingModel": "text-embedding-3-small",
  "lastSyncedAt": "2024-01-15T12:00:00.000Z"
}
```

### List Markets

```bash
GET /api/markets?limit=<n>&offset=<n>&source=<source>&status=<status>
```

**Parameters:**

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `limit` | number | No | 20 | Max results (1-100) |
| `offset` | number | No | 0 | Pagination offset |
| `source` | string | No | - | Filter by source |
| `status` | string | No | - | Filter by status |

**Example:**

```bash
curl "http://localhost:3000/api/markets?limit=10&offset=0"
```

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
  "lastSyncResult": { ... },
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

**Example:**

```bash
curl -X POST "http://localhost:3000/api/admin/sync"
```

**Response:**

```json
{
  "success": true,
  "type": "incremental",
  "synced": {
    "polymarket": {
      "fetched": 500,
      "new": 10,
      "priceUpdates": 490,
      "contentChanged": 2,
      "embeddings": 12
    },
    "kalshi": {
      "fetched": 500,
      "new": 5,
      "priceUpdates": 495,
      "contentChanged": 0,
      "embeddings": 5
    },
    "total": 1000
  },
  "durationMs": 15234
}
```

### Full Sync (Admin)

Trigger a full sync - includes closed/settled markets and updates status:

```bash
POST /api/admin/sync/full
```

**Example:**

```bash
curl -X POST "http://localhost:3000/api/admin/sync/full"
```

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
│   │   └── routes.ts       # Hono API routes
│   ├── db/
│   │   ├── index.ts        # Drizzle client
│   │   └── schema.ts       # Database schema
│   ├── services/
│   │   ├── embedding/
│   │   │   └── openai.ts   # OpenAI embeddings
│   │   ├── ingestion/
│   │   │   ├── polymarket.ts
│   │   │   ├── kalshi.ts
│   │   │   └── normalizer.ts
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
└── tests/
    └── api.test.ts         # API tests
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
bun run db:push      # Push schema directly
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

## Tech Stack

| Component | Technology | Purpose |
|-----------|------------|---------|
| Runtime | Bun | Fast JavaScript/TypeScript runtime |
| Web Framework | Hono | Lightweight, fast HTTP framework |
| Database | PostgreSQL | Market data storage |
| ORM | Drizzle | Type-safe database queries |
| Vector DB | Qdrant | Embedding storage & similarity search |
| Embeddings | OpenAI | text-embedding-3-small (1536 dims) |
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

Check your `.env` file has a valid `OPENAI_API_KEY`.

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
