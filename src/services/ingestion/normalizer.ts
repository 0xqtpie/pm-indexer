import type { NormalizedMarket, MarketStatus } from "../../types/market.ts";
import type { PolymarketMarket } from "../../types/polymarket.ts";
import type { KalshiMarket, KalshiMarketStatus } from "../../types/kalshi.ts";

function parsePolymarketPrice(prices: string[]): { yes: number; no: number } {
  const yesPrice = parseFloat(prices[0] ?? "0.5");
  const noPrice = parseFloat(prices[1] ?? "0.5");
  return {
    yes: isNaN(yesPrice) ? 0.5 : yesPrice,
    no: isNaN(noPrice) ? 0.5 : noPrice,
  };
}

function parsePolymarketStatus(market: PolymarketMarket): MarketStatus {
  if (market.closed) return "closed";
  if (market.archived) return "settled";
  return "open";
}

export function normalizePolymarketMarket(
  market: PolymarketMarket
): NormalizedMarket {
  const prices = parsePolymarketPrice(market.outcomePrices);

  return {
    id: crypto.randomUUID(),
    sourceId: market.id,
    source: "polymarket",

    title: market.question,
    description: market.description ?? "",
    rules: undefined,
    category: market.tags?.[0]?.label,
    tags: market.tags?.map((t) => t.label) ?? [],

    yesPrice: prices.yes,
    noPrice: prices.no,
    lastPrice: prices.yes,

    volume: parseFloat(market.volume) || 0,
    volume24h: parseFloat(market.volume24hr) || 0,
    liquidity: parseFloat(market.liquidity) || 0,

    status: parsePolymarketStatus(market),
    result: null,

    createdAt: new Date(market.startDate || Date.now()),
    openAt: market.startDate ? new Date(market.startDate) : undefined,
    closeAt: market.endDate ? new Date(market.endDate) : undefined,
    expiresAt: market.endDate ? new Date(market.endDate) : undefined,

    url: `https://polymarket.com/event/${market.slug}`,
    imageUrl: market.image || undefined,

    embeddingModel: undefined,
    lastSyncedAt: new Date(),
  };
}

function parseKalshiStatus(status: KalshiMarketStatus): MarketStatus {
  switch (status) {
    case "open":
    case "unopened":
      return "open";
    case "closed":
      return "closed";
    case "settled":
      return "settled";
    default:
      return "open";
  }
}

export function normalizeKalshiMarket(market: KalshiMarket): NormalizedMarket {
  // Kalshi prices are in cents (0-100), convert to 0-1
  const yesPrice = (market.yes_bid + market.yes_ask) / 2 / 100;
  const noPrice = (market.no_bid + market.no_ask) / 2 / 100;

  return {
    id: crypto.randomUUID(),
    sourceId: market.ticker,
    source: "kalshi",

    title: market.title,
    description: market.subtitle ?? "",
    rules: market.rules_primary ?? undefined,
    category: market.category,
    tags: market.tags ?? [],

    yesPrice: isNaN(yesPrice) ? 0.5 : yesPrice,
    noPrice: isNaN(noPrice) ? 0.5 : noPrice,
    lastPrice: market.last_price / 100,

    volume: market.volume ?? 0,
    volume24h: market.volume_24h ?? 0,
    liquidity: undefined,

    status: parseKalshiStatus(market.status),
    result: null,

    createdAt: new Date(market.created_time || Date.now()),
    openAt: market.open_time ? new Date(market.open_time) : undefined,
    closeAt: market.close_time ? new Date(market.close_time) : undefined,
    expiresAt: market.expiration_time
      ? new Date(market.expiration_time)
      : undefined,

    url: `https://kalshi.com/markets/${market.ticker}`,
    imageUrl: undefined,

    embeddingModel: undefined,
    lastSyncedAt: new Date(),
  };
}

export function normalizeMarkets(
  polymarketMarkets: PolymarketMarket[],
  kalshiMarkets: KalshiMarket[]
): NormalizedMarket[] {
  const normalized: NormalizedMarket[] = [];

  for (const market of polymarketMarkets) {
    normalized.push(normalizePolymarketMarket(market));
  }

  for (const market of kalshiMarkets) {
    normalized.push(normalizeKalshiMarket(market));
  }

  return normalized;
}
