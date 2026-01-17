import { describe, test, expect } from "bun:test";
import type { NormalizedMarket } from "../src/types/market.ts";
import type { Market } from "../src/db/schema.ts";
import { categorizeMarkets } from "../src/services/sync/diff.ts";

function buildNormalizedMarket(
  overrides: Partial<NormalizedMarket>
): NormalizedMarket {
  return {
    id: overrides.id ?? "new-id",
    sourceId: overrides.sourceId ?? "source-id",
    source: overrides.source ?? "polymarket",
    title: overrides.title ?? "Title",
    subtitle: overrides.subtitle,
    description: overrides.description ?? "Description",
    rules: overrides.rules,
    category: overrides.category,
    tags: overrides.tags ?? [],
    contentHash: overrides.contentHash ?? "hash",
    yesPrice: overrides.yesPrice ?? 0.5,
    noPrice: overrides.noPrice ?? 0.5,
    lastPrice: overrides.lastPrice,
    volume: overrides.volume ?? 100,
    volume24h: overrides.volume24h ?? 10,
    liquidity: overrides.liquidity,
    status: overrides.status ?? "open",
    result: overrides.result,
    createdAt: overrides.createdAt ?? new Date(),
    openAt: overrides.openAt,
    closeAt: overrides.closeAt,
    expiresAt: overrides.expiresAt,
    url: overrides.url ?? "https://example.com",
    imageUrl: overrides.imageUrl,
    embeddingModel: overrides.embeddingModel,
    lastSyncedAt: overrides.lastSyncedAt ?? new Date(),
  };
}

function buildExistingMarket(overrides: Partial<Market>): Market {
  return {
    id: overrides.id ?? "existing-id",
    sourceId: overrides.sourceId ?? "source-id",
    source: overrides.source ?? "polymarket",
    title: overrides.title ?? "Title",
    subtitle: overrides.subtitle ?? null,
    description: overrides.description ?? "Description",
    rules: overrides.rules ?? null,
    category: overrides.category ?? null,
    tags: overrides.tags ?? [],
    contentHash: overrides.contentHash ?? "hash",
    yesPrice: overrides.yesPrice ?? 0.5,
    noPrice: overrides.noPrice ?? 0.5,
    lastPrice: overrides.lastPrice ?? null,
    volume: overrides.volume ?? 100,
    volume24h: overrides.volume24h ?? 10,
    liquidity: overrides.liquidity ?? null,
    status: overrides.status ?? "open",
    result: overrides.result ?? null,
    createdAt: overrides.createdAt ?? new Date(),
    openAt: overrides.openAt ?? null,
    closeAt: overrides.closeAt ?? null,
    expiresAt: overrides.expiresAt ?? null,
    url: overrides.url ?? "https://example.com",
    imageUrl: overrides.imageUrl ?? null,
    embeddingModel: overrides.embeddingModel ?? null,
    lastSyncedAt: overrides.lastSyncedAt ?? new Date(),
  };
}

describe("categorizeMarkets", () => {
  test("captures status transitions for existing markets", () => {
    const existingBySourceId = new Map<string, Market>([
      [
        "market-open",
        buildExistingMarket({
          id: "id-open",
          sourceId: "market-open",
          status: "open",
          contentHash: "hash-open",
        }),
      ],
      [
        "market-closed",
        buildExistingMarket({
          id: "id-closed",
          sourceId: "market-closed",
          status: "closed",
          contentHash: "hash-closed",
        }),
      ],
    ]);

    const normalizedMarkets: NormalizedMarket[] = [
      buildNormalizedMarket({
        id: "incoming-1",
        sourceId: "market-open",
        status: "closed",
        contentHash: "hash-open",
      }),
      buildNormalizedMarket({
        id: "incoming-2",
        sourceId: "market-closed",
        status: "settled",
        contentHash: "hash-closed",
      }),
    ];

    const result = categorizeMarkets(normalizedMarkets, existingBySourceId);

    expect(result.newMarkets).toBe(0);
    expect(result.updatedPrices).toBe(2);
    expect(result.contentChanged).toBe(0);

    const statuses = result.marketsToUpdatePrices.map((update) => update.status);
    expect(statuses).toContain("closed");
    expect(statuses).toContain("settled");
  });

  test("marks new markets for insert and embedding", () => {
    const existingBySourceId = new Map<string, Market>();
    const normalizedMarkets = [
      buildNormalizedMarket({ id: "new-id", sourceId: "new-source" }),
    ];

    const result = categorizeMarkets(normalizedMarkets, existingBySourceId);

    expect(result.newMarkets).toBe(1);
    expect(result.marketsToInsert).toHaveLength(1);
    expect(result.marketsNeedingEmbeddings).toHaveLength(1);
    expect(result.updatedPrices).toBe(0);
  });

  test("captures price updates without content change", () => {
    const existingBySourceId = new Map<string, Market>([
      [
        "market-1",
        buildExistingMarket({
          id: "existing-id",
          sourceId: "market-1",
          contentHash: "hash",
          yesPrice: 0.4,
        }),
      ],
    ]);

    const normalizedMarkets = [
      buildNormalizedMarket({
        id: "incoming-id",
        sourceId: "market-1",
        contentHash: "hash",
        yesPrice: 0.8,
      }),
    ];

    const result = categorizeMarkets(normalizedMarkets, existingBySourceId);

    expect(result.updatedPrices).toBe(1);
    expect(result.contentChanged).toBe(0);
    expect(result.marketsNeedingEmbeddings).toHaveLength(0);
    expect(result.marketsToUpdatePrices[0]?.yesPrice).toBeCloseTo(0.8);
    expect(result.marketsToUpdatePrices[0]?.prevYesPrice).toBeCloseTo(0.4);
  });

  test("marks content changes for re-embedding", () => {
    const existingBySourceId = new Map<string, Market>([
      [
        "market-1",
        buildExistingMarket({
          id: "existing-id",
          sourceId: "market-1",
          contentHash: "old-hash",
        }),
      ],
    ]);

    const normalizedMarkets = [
      buildNormalizedMarket({
        id: "incoming-id",
        sourceId: "market-1",
        contentHash: "new-hash",
      }),
    ];

    const result = categorizeMarkets(normalizedMarkets, existingBySourceId);

    expect(result.contentChanged).toBe(1);
    expect(result.marketsNeedingEmbeddings).toHaveLength(1);
    expect(result.marketsNeedingEmbeddings[0]?.id).toBe("existing-id");
  });

  test("skips updates when price and status are unchanged", () => {
    const existingBySourceId = new Map<string, Market>([
      [
        "market-1",
        buildExistingMarket({
          id: "existing-id",
          sourceId: "market-1",
          contentHash: "hash",
          yesPrice: 0.6,
          noPrice: 0.4,
          volume: 12,
          volume24h: 3,
          status: "open",
        }),
      ],
    ]);

    const normalizedMarkets = [
      buildNormalizedMarket({
        id: "incoming-id",
        sourceId: "market-1",
        contentHash: "hash",
        yesPrice: 0.6,
        noPrice: 0.4,
        volume: 12,
        volume24h: 3,
        status: "open",
      }),
    ];

    const result = categorizeMarkets(normalizedMarkets, existingBySourceId);

    expect(result.updatedPrices).toBe(0);
    expect(result.marketsToUpdatePrices).toHaveLength(0);
  });
});
