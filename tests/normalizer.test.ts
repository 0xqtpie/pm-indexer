import { describe, test, expect } from "bun:test";
import type { PolymarketMarket } from "../src/types/polymarket.ts";
import type { KalshiMarket } from "../src/types/kalshi.ts";
import {
  normalizePolymarketMarket,
  normalizeKalshiMarket,
} from "../src/services/ingestion/normalizer.ts";

function buildPolymarketMarket(
  overrides: Partial<PolymarketMarket> = {}
): PolymarketMarket {
  const hasOutcomePrices = Object.prototype.hasOwnProperty.call(
    overrides,
    "outcomePrices"
  );
  const outcomePrices = hasOutcomePrices
    ? overrides.outcomePrices
    : ["0.6", "0.4"];

  return {
    id: overrides.id ?? "market-1",
    question: overrides.question ?? "Will it rain?",
    description: overrides.description ?? "Test description",
    slug: overrides.slug ?? "will-it-rain",
    conditionId: overrides.conditionId ?? "condition-1",
    outcomes: overrides.outcomes ?? ["Yes", "No"],
    outcomePrices: outcomePrices as string[],
    volume: overrides.volume ?? "1000",
    volume24hr: overrides.volume24hr ?? "100",
    liquidity: overrides.liquidity ?? "500",
    startDate: overrides.startDate ?? new Date().toISOString(),
    endDate: overrides.endDate ?? new Date().toISOString(),
    closed: overrides.closed ?? false,
    active: overrides.active ?? true,
    archived: overrides.archived ?? false,
    image: overrides.image ?? "",
    icon: overrides.icon ?? "",
    tags: overrides.tags,
    events: overrides.events,
    groupItemTitle: overrides.groupItemTitle,
  };
}

function buildKalshiMarket(overrides: Partial<KalshiMarket> = {}): KalshiMarket {
  return {
    ticker: overrides.ticker ?? "KALSHI-TEST",
    event_ticker: overrides.event_ticker ?? "EVENT-TEST",
    title: overrides.title ?? "Kalshi market",
    subtitle: overrides.subtitle ?? "Subtitle",
    status: overrides.status ?? "active",
    yes_bid: overrides.yes_bid ?? 40,
    yes_ask: overrides.yes_ask ?? 60,
    no_bid: overrides.no_bid ?? 40,
    no_ask: overrides.no_ask ?? 60,
    yes_sub_title: overrides.yes_sub_title,
    no_sub_title: overrides.no_sub_title,
    last_price: overrides.last_price ?? 50,
    volume: overrides.volume ?? 1000,
    volume_24h: overrides.volume_24h ?? 100,
    open_interest: overrides.open_interest ?? 100,
    created_time: overrides.created_time ?? new Date().toISOString(),
    open_time: overrides.open_time ?? new Date().toISOString(),
    close_time: overrides.close_time ?? new Date().toISOString(),
    expiration_time: overrides.expiration_time ?? new Date().toISOString(),
    rules_primary: overrides.rules_primary ?? "Rules",
    rules_secondary: overrides.rules_secondary ?? "Rules 2",
    category: overrides.category,
    tags: overrides.tags,
  };
}

describe("normalizePolymarketMarket", () => {
  test("defaults prices when outcomePrices are missing", async () => {
    const market = buildPolymarketMarket({ outcomePrices: undefined });
    const normalized = await normalizePolymarketMarket(market);

    expect(normalized.yesPrice).toBeCloseTo(0.5);
    expect(normalized.noPrice).toBeCloseTo(0.5);
  });

  test("handles invalid outcomePrices JSON string", async () => {
    const market = buildPolymarketMarket({
      outcomePrices: "not-json" as unknown as string[],
    });
    const normalized = await normalizePolymarketMarket(market);

    expect(normalized.yesPrice).toBeCloseTo(0.5);
    expect(normalized.noPrice).toBeCloseTo(0.5);
  });

  test("parses outcomePrices JSON string", async () => {
    const market = buildPolymarketMarket({
      outcomePrices: JSON.stringify(["0.7", "0.3"]) as unknown as string[],
    });
    const normalized = await normalizePolymarketMarket(market);

    expect(normalized.yesPrice).toBeCloseTo(0.7);
    expect(normalized.noPrice).toBeCloseTo(0.3);
  });
});

describe("normalizeKalshiMarket", () => {
  test("defaults prices when bid/ask are NaN", async () => {
    const market = buildKalshiMarket({
      yes_bid: NaN,
      yes_ask: NaN,
      no_bid: NaN,
      no_ask: NaN,
    });
    const normalized = await normalizeKalshiMarket(market);

    expect(normalized.yesPrice).toBeCloseTo(0.5);
    expect(normalized.noPrice).toBeCloseTo(0.5);
  });
});
