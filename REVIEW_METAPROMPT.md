# Prediction Market Indexer - Review Metaprompt

> Use this document to guide LLM agents in reviewing this repository and suggesting improvements.

---

## Repository Overview

**Name:** pm-indexer
**Purpose:** A semantic search engine for prediction markets that aggregates data from multiple platforms (Polymarket, Kalshi), generates vector embeddings, and provides a REST API for intelligent market discovery.

**Core Value Proposition:** Search for concepts like "cryptocurrency" and find related markets about Bitcoin, even if exact words don't match. Enables discovery across prediction market platforms through semantic understanding.

---

## Current Architecture

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

---

## Tech Stack

| Component | Technology | Notes |
|-----------|------------|-------|
| Runtime | Bun v1.0+ | Fast JS/TS runtime with native TypeScript support |
| Web Framework | Hono | Lightweight, ~12KB, faster than Express |
| Database | PostgreSQL | Market data storage via Drizzle ORM |
| Vector DB | Qdrant | 1536-dim cosine similarity search |
| Embeddings | OpenAI | text-embedding-3-small model |
| Validation | Zod | Runtime type validation |
| HTTP Client | ky | Fetch wrapper with retry logic |

---

## Project Structure

```
pm-indexer/
├── src/
│   ├── index.ts                    # Entry point (Bun.serve + scheduler)
│   ├── config.ts                   # Environment validation (Zod)
│   ├── api/
│   │   └── routes.ts               # Hono routes (5 endpoints)
│   ├── db/
│   │   ├── index.ts                # Drizzle client
│   │   └── schema.ts               # PostgreSQL table (markets)
│   ├── services/
│   │   ├── embedding/
│   │   │   └── openai.ts           # OpenAI API (batch 100)
│   │   ├── ingestion/
│   │   │   ├── polymarket.ts       # Gamma API client
│   │   │   ├── kalshi.ts           # Trade API client
│   │   │   └── normalizer.ts       # Platform → NormalizedMarket
│   │   ├── search/
│   │   │   └── qdrant.ts           # Vector DB operations
│   │   ├── sync/
│   │   │   └── index.ts            # Incremental/full sync logic
│   │   └── scheduler/
│   │       └── index.ts            # Background cron scheduler
│   └── types/
│       ├── market.ts               # NormalizedMarket interface
│       ├── polymarket.ts           # Polymarket API types
│       └── kalshi.ts               # Kalshi API types
├── scripts/
│   ├── seed.ts                     # Initial data load
│   └── reset.ts                    # Clear all data
└── tests/
    └── search.test.ts              # 26 integration tests
```

---

## Data Model

### NormalizedMarket (Core Domain Object)

```typescript
interface NormalizedMarket {
  // Identity
  id: string;           // UUID
  sourceId: string;     // External platform ID
  source: "polymarket" | "kalshi";

  // Content (used for embeddings)
  title: string;
  subtitle?: string;    // Choice label for multi-outcome markets
  description: string;
  rules?: string;
  category?: string;
  tags: string[];
  contentHash: string;  // SHA-256 for change detection

  // Pricing (0-1 probabilities)
  yesPrice: number;
  noPrice: number;
  lastPrice?: number;

  // Volume (USD)
  volume: number;
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
  embeddingModel?: string;
  lastSyncedAt: Date;
}
```

### PostgreSQL Schema

Single `markets` table with:
- Unique compound index: `(source, sourceId)`
- ENUMs: `market_source`, `market_status`, `market_result`
- JSONB: `tags` array

### Qdrant Payload

Truncated subset stored with vectors:
- `source`, `sourceId`, `title`, `subtitle`, `description` (max 1000 chars)
- `status`, `yesPrice`, `noPrice`, `volume`, `volume24h`
- `closeAt`, `url`, `tags`, `category`

---

## API Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/health` | GET | Health check |
| `/api/search` | GET | Semantic search with filters |
| `/api/markets/:id` | GET | Get single market |
| `/api/markets` | GET | List markets (paginated) |
| `/api/admin/sync/status` | GET | Sync status |
| `/api/admin/sync` | POST | Trigger incremental sync |
| `/api/admin/sync/full` | POST | Trigger full sync |

### Search Parameters

- `q` (required): Natural language query
- `limit` (1-100, default 20)
- `source`: polymarket | kalshi
- `status`: open | closed | settled
- `minVolume`: Minimum USD volume

---

## Sync System

### Incremental Sync (every 30 min by default)
1. Fetch open markets from both APIs
2. Compare `sourceId` against existing DB records
3. NEW markets: insert + generate embedding
4. EXISTING markets: update prices only (no embedding cost)
5. CONTENT_CHANGED: re-generate embedding if contentHash differs

### Full Sync (daily at 3 AM by default)
- Same logic as incremental
- Intended for status updates (open → closed → settled)

### Cost Optimization
- Content hash (SHA-256) prevents unnecessary re-embeddings
- Typical incremental: ~10-50 new embeddings/run (~$0.001)
- Initial seed: ~$0.72 for 60,000 markets

---

## Current State Assessment

### Strengths

1. **Clean Architecture**: Clear separation of concerns (ingestion → normalization → embedding → storage → search)
2. **Type Safety**: Full TypeScript with Zod validation at boundaries
3. **Cost Optimization**: Content hashing minimizes embedding API calls
4. **Extensible Design**: Easy to add new prediction market sources
5. **Good Test Coverage**: 26 integration tests covering semantic relevance, filtering, edge cases
6. **Modern Stack**: Bun runtime, Hono framework, Drizzle ORM

### Known Issues / Technical Debt

1. **Sync Performance**: Price updates are done one-by-one in a loop (`src/services/sync/index.ts:306-320`)
2. **Global State**: Sync status tracked via module-level variables (non-ideal for scaling)
3. **No Authentication**: Admin endpoints are unprotected
4. **No Rate Limiting**: API has no request rate limiting
5. **Limited Error Handling**: Errors are caught but not categorized or retried strategically
6. **No Caching**: Search queries generate embeddings on every request

---

## Review Focus Areas

When reviewing this repository, please analyze and provide recommendations for the following areas:

### 1. Architecture & System Design

**Questions to Address:**
- Is the current architecture appropriate for the scale (10K-100K markets)?
- How would you evolve the architecture for 1M+ markets?
- Should embeddings be generated synchronously during search, or cached?
- Is the dual-database approach (Postgres + Qdrant) optimal, or could one suffice?
- How would you handle multi-tenancy if this became a SaaS product?

**Specific Files to Review:**
- `src/index.ts` - Entry point and server setup
- `src/services/sync/index.ts` - Sync orchestration
- `src/services/search/qdrant.ts` - Vector search implementation

**Consider:**
- Event sourcing for market state changes
- CQRS pattern for read/write separation
- Message queues for decoupling sync from API
- Horizontal scaling strategies

### 2. API Design & UX

**Questions to Address:**
- Is the REST API design intuitive and following best practices?
- What additional endpoints would improve developer experience?
- How could the search UX be enhanced (facets, suggestions, aggregations)?
- Should GraphQL be considered for flexible querying?

**Specific Files to Review:**
- `src/api/routes.ts` - All API endpoints
- Response payload structures
- Error response formats

**Consider:**
- Pagination improvements (cursor-based vs offset)
- Field selection/projection
- Sorting options beyond relevance
- Search result highlighting
- Autocomplete/typeahead support
- WebSocket for real-time price updates

### 3. Feature Gaps

**Questions to Address:**
- What features are missing for a production-ready product?
- How could market discovery be improved beyond semantic search?
- What analytics/insights could be derived from the data?

**Consider Adding:**
- Market watchlists / alerts
- Price history tracking
- Market comparison tools
- Category/tag exploration
- Trending markets detection
- Market correlation analysis
- Historical accuracy tracking (how often markets resolve correctly)
- Similar market recommendations

### 4. Performance Optimization

**Questions to Address:**
- Where are the performance bottlenecks?
- How can sync performance be improved?
- What caching strategies would help?
- How can search latency be reduced?

**Specific Files to Review:**
- `src/services/sync/index.ts:306-320` - Individual price updates
- `src/services/embedding/openai.ts` - Embedding generation
- `src/api/routes.ts:36-91` - Search endpoint

**Consider:**
- Batch SQL updates instead of loops
- Query embedding caching (LRU cache for common queries)
- Connection pooling optimization
- Qdrant HNSW index tuning
- Pre-computed embeddings for common categories
- Background job queues for expensive operations

### 5. Reliability & Observability

**Questions to Address:**
- How robust is the system against API failures?
- What monitoring/alerting is missing?
- How would you implement graceful degradation?

**Consider:**
- Structured logging (instead of console.log)
- Metrics collection (Prometheus, etc.)
- Distributed tracing
- Health check improvements
- Circuit breakers for external APIs
- Dead letter queues for failed syncs
- Alerting on sync failures or data staleness

### 6. Security

**Questions to Address:**
- What security vulnerabilities exist?
- How should admin endpoints be protected?
- What data privacy concerns exist?

**Consider:**
- API authentication (API keys, JWT)
- Rate limiting per client
- Input sanitization (SQL injection, XSS)
- Secrets management
- Audit logging
- CORS policy tightening

### 7. Code Quality

**Questions to Address:**
- What refactoring would improve maintainability?
- Are there any anti-patterns?
- Is the code sufficiently documented?

**Consider:**
- Dependency injection for testability
- Repository pattern for data access
- Error handling standardization
- Unit tests (currently only integration tests exist)
- Code documentation for complex logic

### 8. Data Quality & Integrity

**Questions to Address:**
- How is data freshness ensured?
- What happens when source APIs have inconsistent data?
- How are duplicate markets handled?

**Consider:**
- Data validation on ingestion
- Conflict resolution strategies
- Stale data detection
- Market deduplication across sources
- Data reconciliation jobs

---

## Constraints & Context

When making recommendations, please consider:

1. **Tech Stack**: Must use Bun runtime (not Node.js). See `CLAUDE.md` for specifics.
2. **Cost Sensitivity**: OpenAI API calls cost money; minimize embedding regeneration.
3. **External API Limitations**: Polymarket/Kalshi have undocumented rate limits.
4. **Deployment**: Currently Docker-based; assume single-instance deployment for now.
5. **Team Size**: Assume solo developer or small team; avoid over-engineering.

---

## Expected Output Format

Please provide your review in the following format:

```markdown
## Executive Summary
[2-3 sentence overview of findings]

## Critical Issues
[Issues that should be addressed immediately]

## Architecture Recommendations
[High-level design changes with diagrams if helpful]

## API/UX Improvements
[Specific endpoint changes, new features]

## Performance Optimizations
[Specific code changes with file:line references]

## Feature Recommendations
[Prioritized list of new features]

## Security Fixes
[Specific vulnerabilities and mitigations]

## Code Quality Improvements
[Refactoring suggestions with examples]

## Implementation Roadmap
[Suggested order of implementation with rough effort estimates]
```

---

## Key Files for Deep Review

| Priority | File | Purpose | Lines |
|----------|------|---------|-------|
| HIGH | `src/services/sync/index.ts` | Sync orchestration, performance issues | 356 |
| HIGH | `src/api/routes.ts` | All API endpoints | 238 |
| HIGH | `src/services/search/qdrant.ts` | Vector search implementation | 148 |
| MEDIUM | `src/services/ingestion/normalizer.ts` | Data transformation | ~150 |
| MEDIUM | `src/services/embedding/openai.ts` | Embedding generation | ~80 |
| MEDIUM | `src/db/schema.ts` | Database schema | 80 |
| LOW | `src/services/scheduler/index.ts` | Background jobs | 139 |
| LOW | `src/config.ts` | Environment config | ~60 |

---

## Questions for the Reviewer

After completing your review, please address:

1. What is the single most impactful change you would recommend?
2. Are there any "hidden" issues not covered in the focus areas above?
3. What would you build differently if starting from scratch?
4. What's the most underutilized aspect of the current tech stack?
5. What monitoring would you implement first?

---

## Additional Context

- The codebase has ~2,000 lines of application code
- 26 integration tests with good coverage of search functionality
- No CI/CD pipeline configured yet
- README is comprehensive but may be outdated in places
- Git shows active development with recent commits

---

*Generated for LLM agent review. Last updated: January 2026*
