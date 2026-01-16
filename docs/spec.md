# Prediction Market Indexer - Technical Specification

## Overview

A semantic search engine for prediction markets that ingests market data from multiple platforms (Polymarket, Kalshi) and enables semantic querying. Users can search for concepts like "ayatollah" and surface related markets about Iran protests, Israel-Iran relations, etc.

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        API Layer (Hono)                         │
│  GET /search?q=...  │  GET /markets/:id  │  POST /admin/sync   │
└─────────────────────────────────────────────────────────────────┘
                                │
┌───────────────────────────────┼───────────────────────────────┐
│                         Core Services                          │
│  ┌─────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │   Ingestion │  │  Embedding Svc   │  │   Search Svc     │  │
│  │   Service   │  │  (OpenAI/Voyage) │  │   (Vector DB)    │  │
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
│  │   PostgreSQL    │              │   Qdrant        │         │
│  │ (market data)   │              │ (embeddings)    │         │
│  └─────────────────┘              └─────────────────┘         │
└───────────────────────────────────────────────────────────────┘
```

---

## Data Sources & API Details

### Polymarket - Gamma API

**Base URL:** `https://gamma-api.polymarket.com`

**Key Endpoints:**

| Endpoint         | Method | Description                                |
| ---------------- | ------ | ------------------------------------------ |
| `/events`        | GET    | List events (parent container for markets) |
| `/markets`       | GET    | List individual markets                    |
| `/events/{slug}` | GET    | Get single event by slug                   |
| `/markets/{id}`  | GET    | Get single market by ID                    |

**Pagination:** Uses `limit` and `offset` parameters

- Default limit: 100
- Recommended: Page through `/events?closed=false&limit=100&offset=N`

**Key Query Parameters:**

- `closed`: boolean - filter by open/closed status
- `active`: boolean - filter active markets
- `order`: string - field to order by (e.g., `id`)
- `ascending`: boolean - sort direction
- `tag_id`: string - filter by category tag

**Response Shape (Market):**

```typescript
interface PolymarketMarket {
  id: string;
  question: string;
  description: string;
  slug: string;
  conditionId: string;
  outcomes: string[]; // ["Yes", "No"]
  outcomePrices: string[]; // ["0.65", "0.35"]
  volume: string;
  volume24hr: string;
  liquidity: string;
  startDate: string;
  endDate: string;
  closed: boolean;
  active: boolean;
  archived: boolean;
  image: string;
  icon: string;
  tags?: Array<{ id: string; slug: string; label: string }>;
  events?: PolymarketEvent[];
}
```

**Rate Limits:** ~100 requests/minute (undocumented, be conservative)

---

### Kalshi - Trade API v2

**Base URL:** `https://api.elections.kalshi.com/trade-api/v2`

> Note: Despite "elections" in URL, this serves ALL Kalshi markets

**Key Endpoints:**

| Endpoint                  | Method | Auth Required | Description       |
| ------------------------- | ------ | ------------- | ----------------- |
| `/markets`                | GET    | No            | List all markets  |
| `/markets/{ticker}`       | GET    | No            | Get single market |
| `/events`                 | GET    | No            | List events       |
| `/events/{event_ticker}`  | GET    | No            | Get single event  |
| `/series/{series_ticker}` | GET    | No            | Get series info   |

**Pagination:** Cursor-based

- `limit`: 1-1000 (default 100)
- `cursor`: returned in response for next page

**Key Query Parameters for `/markets`:**

- `status`: `unopened` | `open` | `closed` | `settled`
- `series_ticker`: filter by series
- `event_ticker`: filter by event
- `tickers`: comma-separated market tickers
- `min_close_ts` / `max_close_ts`: timestamp filters

**Response Shape (Market):**

```typescript
interface KalshiMarket {
  ticker: string; // "KXTRUMP-26JAN20-T95"
  event_ticker: string;
  title: string;
  subtitle: string;
  status: "unopened" | "open" | "closed" | "settled";
  yes_bid: number; // in cents
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  created_time: string;
  open_time: string;
  close_time: string;
  expiration_time: string;
  rules_primary: string; // Resolution rules
  rules_secondary: string;
}
```

---

## Normalized Data Model

```typescript
interface NormalizedMarket {
  // Identity
  id: string; // internal UUID
  sourceId: string; // original platform ID
  source: "polymarket" | "kalshi";

  // Content (for embedding)
  title: string;
  description: string;
  rules?: string;
  category?: string;
  tags: string[];

  // Pricing
  yesPrice: number; // 0-1 probability
  noPrice: number;
  lastPrice?: number;

  // Volume
  volume: number; // in USD
  volume24h: number;
  liquidity?: number;

  // Status
  status: "open" | "closed" | "settled";
  result?: "yes" | "no" | null;

  // Timestamps
  createdAt: Date;
  openAt?: Date;
  closeAt?: Date;
  expiresAt?: Date;

  // Metadata
  url: string;
  imageUrl?: string;

  // Search
  embedding?: number[]; // stored in vector DB
  embeddingModel: string;
  lastSyncedAt: Date;
}
```

---

## Embedding Strategy

### Recommended Model: OpenAI `text-embedding-3-small`

**Rationale:**

- Best cost/performance ratio for this use case
- 1536 dimensions (good balance)
- $0.02 / 1M tokens
- Handles prediction market language well

**Alternatives:**

- `text-embedding-3-large` (3072 dim) - if accuracy is paramount
- `voyage-3-lite` - competitive performance, slightly cheaper
- `cohere-embed-v3` - good for noisy real-world text

### Text to Embed

Concatenate into a single string for embedding:

```typescript
function buildEmbeddingText(market: NormalizedMarket): string {
  const parts = [market.title, market.description, market.rules].filter(Boolean);

  return parts.join("\n\n");
}
```

### Embedding Dimensions

Use 1536 dimensions. If storage is a concern, OpenAI supports dimension reduction:

```typescript
const response = await openai.embeddings.create({
  model: "text-embedding-3-small",
  input: text,
  dimensions: 512, // optional: reduce for storage
});
```

---

## Vector Database: Qdrant

### Why Qdrant?

- Easy local Docker setup
- Scales to hosted cloud when needed
- Good TypeScript SDK
- Supports filtering + vector search combined

### Collection Schema

```typescript
// Create collection
await qdrant.createCollection("markets", {
  vectors: {
    size: 1536,
    distance: "Cosine",
  },
});

// Point structure
interface QdrantPoint {
  id: string; // market.id (UUID)
  vector: number[]; // embedding
  payload: {
    source: string;
    sourceId: string;
    title: string;
    status: string;
    yesPrice: number;
    volume: number;
    closeAt: string | null;
    url: string;
    tags: string[];
  };
}
```

### Search Query

```typescript
const results = await qdrant.search("markets", {
  vector: queryEmbedding,
  limit: 20,
  filter: {
    must: [{ key: "status", match: { value: "open" } }],
  },
  with_payload: true,
});
```

---

## Project Structure

```
prediction-market-indexer/
├── docker-compose.yml
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts                 # Entry point
│   ├── config.ts                # Environment config
│   ├── api/
│   │   ├── routes.ts            # Hono routes
│   │   └── middleware.ts
│   ├── services/
│   │   ├── ingestion/
│   │   │   ├── index.ts
│   │   │   ├── polymarket.ts    # Polymarket client
│   │   │   ├── kalshi.ts        # Kalshi client
│   │   │   └── normalizer.ts    # Data normalization
│   │   ├── embedding/
│   │   │   ├── index.ts
│   │   │   └── openai.ts        # OpenAI embedding client
│   │   ├── search/
│   │   │   ├── index.ts
│   │   │   └── qdrant.ts        # Qdrant client
│   │   └── sync/
│   │       └── scheduler.ts     # Cron job orchestration
│   ├── db/
│   │   ├── index.ts             # Drizzle client
│   │   ├── schema.ts            # Drizzle schema
│   │   └── migrations/
│   └── types/
│       ├── polymarket.ts
│       ├── kalshi.ts
│       └── market.ts
├── scripts/
│   ├── seed.ts                  # Initial full sync
│   └── migrate.ts               # Run migrations
└── tests/
    └── ...
```

---

## Tech Stack

| Component      | Choice                          | Rationale                   |
| -------------- | ------------------------------- | --------------------------- |
| Runtime        | Node.js + TypeScript            | You requested TS            |
| HTTP Framework | Hono                            | Fast, lightweight, great DX |
| Database       | PostgreSQL + Drizzle ORM        | Reliable, typed queries     |
| Vector DB      | Qdrant                          | Easy Docker, good SDK       |
| Embeddings     | OpenAI `text-embedding-3-small` | Best cost/perf ratio        |
| Scheduler      | node-cron or BullMQ             | Periodic sync jobs          |
| Validation     | Zod                             | Runtime type safety         |
| HTTP Client    | ky or ofetch                    | Modern fetch wrapper        |

---

## Key Flows

### 1. Initial Sync (Full Ingest)

```
┌─────────┐     ┌─────────────┐     ┌────────────┐     ┌─────────┐
│  Start  │────▶│ Fetch all   │────▶│ Normalize  │────▶│ Generate│
│         │     │ markets     │     │ to schema  │     │ embeddings
└─────────┘     └─────────────┘     └────────────┘     └────┬────┘
                                                            │
┌─────────┐     ┌─────────────┐     ┌────────────┐          │
│  Done   │◀────│ Upsert to   │◀────│ Store in   │◀─────────┘
│         │     │ Qdrant      │     │ Postgres   │
└─────────┘     └─────────────┘     └────────────┘
```

### 2. Incremental Sync (Every 5-15 min)

```typescript
async function incrementalSync() {
  const lastSync = await getLastSyncTimestamp();

  // Fetch only recently updated markets
  const polymarkets = await polymarket.getMarkets({
    // No good "updated since" filter, so fetch active only
    active: true,
    closed: false,
  });

  const kalshiMarkets = await kalshi.getMarkets({
    status: "open",
    min_created_ts: lastSync.unix(),
  });

  // Diff against existing, update changed ones
  // Re-embed if title/description changed
}
```

### 3. Search Flow

```
┌─────────────┐     ┌─────────────┐     ┌─────────────┐
│ User query  │────▶│ Embed query │────▶│ Vector      │
│ "ayatollah" │     │ (OpenAI)    │     │ similarity  │
└─────────────┘     └─────────────┘     └──────┬──────┘
                                               │
┌─────────────┐     ┌─────────────┐            │
│ Return top  │◀────│ Hydrate     │◀───────────┘
│ 20 markets  │     │ from PG     │
└─────────────┘     └─────────────┘
```

---

## API Endpoints

### `GET /api/search`

Semantic search across all markets.

**Query Parameters:**

- `q` (required): Search query string
- `limit`: Number of results (default: 20, max: 100)
- `cursor`: Pagination cursor from `meta.nextCursor`
- `sort`: `relevance` | `volume` | `closeAt`
- `order`: `asc` | `desc`
- `source`: Filter by `polymarket` | `kalshi`
- `status`: Filter by `open` | `closed` | `settled`
- `minVolume`: Minimum volume in USD

**Response:**

```json
{
  "query": "ayatollah",
  "results": [
    {
      "id": "uuid",
      "source": "polymarket",
      "title": "Will Iran's Supreme Leader die in 2025?",
      "yesPrice": 0.12,
      "volume": 45000,
      "url": "https://polymarket.com/...",
      "score": 0.89
    }
  ],
  "meta": {
    "took_ms": 45,
    "total": 15,
    "nextCursor": "eyJvZmZzZXQiOjIwfQ=="
  }
}
```

### `GET /api/markets/:id`

Get full market details.

### `GET /api/markets`

List markets with filters (traditional filtering, not semantic).

### `GET /api/search/suggest`

Typeahead suggestions from market titles.

### `GET /api/tags` / `GET /api/categories`

Facet endpoints for tags and categories.

### `GET /metrics`

Returns sync and external API error counters.

### `POST /api/admin/sync`

Trigger manual sync (protected endpoint).

---

## Docker Setup

```yaml
# docker-compose.yml
services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - DATABASE_URL=postgres://user:pass@db:5432/markets
      - QDRANT_URL=http://qdrant:6333
      - OPENAI_API_KEY=${OPENAI_API_KEY}
    depends_on:
      - db
      - qdrant

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: user
      POSTGRES_PASSWORD: pass
      POSTGRES_DB: markets
    volumes:
      - pgdata:/var/lib/postgresql/data
    ports:
      - "5432:5432"

  qdrant:
    image: qdrant/qdrant:latest
    ports:
      - "6333:6333"
    volumes:
      - qdrant_data:/qdrant/storage

volumes:
  pgdata:
  qdrant_data:
```

---

## Environment Variables

```bash
# .env.example
DATABASE_URL=postgres://user:pass@localhost:5432/markets
QDRANT_URL=http://localhost:6333
OPENAI_API_KEY=sk-...
ADMIN_API_KEY=your-admin-key
CORS_ORIGINS=*
SEARCH_RATE_LIMIT_MAX=60
SEARCH_RATE_LIMIT_WINDOW_SECONDS=60
QUERY_EMBEDDING_CACHE_MAX_ENTRIES=1000
QUERY_EMBEDDING_CACHE_TTL_SECONDS=300

# Sync settings
SYNC_INTERVAL_MINUTES=10
FULL_SYNC_HOUR=3  # 3 AM daily full sync

# Optional
LOG_LEVEL=info
PORT=3000
```

---

## Implementation Order

### Phase 1: Foundation

1. Set up project with TypeScript, Hono, Docker
2. Implement Polymarket client with pagination
3. Implement Kalshi client with pagination
4. Create normalized data model and Drizzle schema
5. Basic API routes (health check, list markets)

### Phase 2: Embeddings

6. Integrate OpenAI embeddings
7. Set up Qdrant collection
8. Implement embedding generation for markets
9. Write initial seed script

### Phase 3: Search

10. Implement semantic search endpoint
11. Add filtering (status, source, volume)
12. Add result hydration from Postgres

### Phase 4: Sync

13. Implement incremental sync logic
14. Add cron scheduler for periodic sync
15. Handle market updates (re-embed on change)

### Phase 5: Polish

16. Add proper error handling
17. Rate limiting on API
18. Logging and monitoring
19. Tests

---

## Estimated Costs (at scale)

| Resource                 | Monthly Cost | Notes                           |
| ------------------------ | ------------ | ------------------------------- |
| OpenAI Embeddings        | ~$5-20       | ~1M tokens/month for 5k markets |
| Qdrant Cloud (if hosted) | $25+         | Or free with Docker locally     |
| PostgreSQL (hosted)      | $15+         | Or free with Docker locally     |
| Compute (VPS)            | $10-20       | 2GB RAM sufficient              |

**Total:** ~$50-75/month hosted, or ~$5-20/month if self-hosted on a cheap VPS with just embedding costs.

---

## Notes for Claude Code

- Start with a single source (Polymarket) to validate the pipeline
- Use `ky` or `ofetch` for HTTP - they handle retries nicely
- Batch embedding calls (OpenAI supports batching)
- Consider adding a simple web UI later (could use htmx or React)
- The Gamma API doesn't require auth for read operations
- Kalshi public endpoints also don't require auth
- Both APIs have undocumented rate limits - add exponential backoff
