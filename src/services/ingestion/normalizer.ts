import type { NormalizedMarket, MarketStatus } from "../../types/market.ts";
import { computeContentHash } from "../../types/market.ts";
import type { PolymarketMarket } from "../../types/polymarket.ts";
import type { KalshiMarket, KalshiMarketStatus } from "../../types/kalshi.ts";

function parsePolymarketPrice(prices?: string[] | string): { yes: number; no: number } {
  // Handle missing prices
  if (!prices) {
    return { yes: 0.5, no: 0.5 };
  }

  // Polymarket API returns outcomePrices as a JSON string, not an array
  let priceArray: string[];
  if (typeof prices === "string") {
    try {
      priceArray = JSON.parse(prices);
    } catch {
      return { yes: 0.5, no: 0.5 };
    }
  } else if (Array.isArray(prices)) {
    priceArray = prices;
  } else {
    return { yes: 0.5, no: 0.5 };
  }

  const yesPrice = parseFloat(priceArray[0] ?? "0.5");
  const noPrice = parseFloat(priceArray[1] ?? "0.5");
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

export async function normalizePolymarketMarket(
  market: PolymarketMarket
): Promise<NormalizedMarket> {
  const prices = parsePolymarketPrice(market.outcomePrices);
  const title = market.question;
  const description = market.description ?? "";
  const contentHash = await computeContentHash(title, description, undefined);

  return {
    id: crypto.randomUUID(),
    sourceId: market.id,
    source: "polymarket",

    title,
    subtitle: market.groupItemTitle, // Choice label for multi-outcome markets
    description,
    rules: undefined,
    category: market.tags?.[0]?.label,
    tags: market.tags?.map((t) => t.label) ?? [],
    contentHash,

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
    case "active": // Events endpoint returns "active" instead of "open"
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

export async function normalizeKalshiMarket(
  market: KalshiMarket
): Promise<NormalizedMarket> {
  // Kalshi prices are in cents (0-100), convert to 0-1
  const yesPrice = (market.yes_bid + market.yes_ask) / 2 / 100;
  const noPrice = (market.no_bid + market.no_ask) / 2 / 100;
  const title = market.title;
  const description = market.subtitle ?? "";
  const rules = market.rules_primary ?? undefined;
  const contentHash = await computeContentHash(title, description, rules);

  return {
    id: crypto.randomUUID(),
    sourceId: market.ticker,
    source: "kalshi",

    title,
    subtitle: market.yes_sub_title, // Choice label for multi-outcome markets
    description,
    rules,
    category: market.category,
    tags: market.tags ?? [],
    contentHash,

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

export async function normalizeMarkets(
  polymarketMarkets: PolymarketMarket[],
  kalshiMarkets: KalshiMarket[]
): Promise<NormalizedMarket[]> {
  const normalized: NormalizedMarket[] = [];

  // Process in batches to avoid overwhelming with promises
  for (const market of polymarketMarkets) {
    normalized.push(await normalizePolymarketMarket(market));
  }

  for (const market of kalshiMarkets) {
    normalized.push(await normalizeKalshiMarket(market));
  }

  return normalized;
}
