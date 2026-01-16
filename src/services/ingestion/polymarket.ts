import ky from "ky";
import type { PolymarketMarket, PolymarketEvent } from "../../types/polymarket.ts";
import { recordExternalApiFailure } from "./errors.ts";

const BASE_URL = "https://gamma-api.polymarket.com";
const PAGE_SIZE = 100;

export type PolymarketFetchStatus = "open" | "closed" | "settled" | "all";

// Sports-related tags to filter out
const SPORTS_TAGS = [
  "Sports",
  "NFL",
  "NBA",
  "MLB",
  "NHL",
  "Soccer",
  "Football",
  "Basketball",
  "Baseball",
  "Hockey",
  "Tennis",
  "Golf",
  "FIFA",
  "NCAA",
  "UFC",
  "Boxing",
  "MMA",
  "Cricket",
  "Rugby",
  "F1",
  "NASCAR",
  "Olympics",
];

function isSportsMarket(market: PolymarketMarket): boolean {
  const tags = market.tags?.map((t) => t.label.toLowerCase()) ?? [];
  return SPORTS_TAGS.some((sport) =>
    tags.some((tag) => tag.toLowerCase().includes(sport.toLowerCase()))
  );
}

function shouldIncludeMarket(
  market: PolymarketMarket,
  status: PolymarketFetchStatus,
  excludeSports: boolean
): boolean {
  if (excludeSports && isSportsMarket(market)) return false;

  switch (status) {
    case "open":
      return !market.closed && !market.archived;
    case "closed":
      return market.closed && !market.archived;
    case "settled":
      return market.archived;
    case "all":
      return true;
    default:
      return !market.closed && !market.archived;
  }
}

async function fetchPolymarketMarketsByStatus(
  status: Exclude<PolymarketFetchStatus, "all">,
  limit: number,
  excludeSports: boolean
): Promise<PolymarketMarket[]> {
  const allMarkets: PolymarketMarket[] = [];
  let offset = 0;

  while (allMarkets.length < limit) {
    const searchParams: Record<string, string | number | boolean> = {
      limit: PAGE_SIZE,
      offset,
    };

    if (status === "open") {
      searchParams.closed = false;
    } else if (status === "closed") {
      searchParams.closed = true;
    } else if (status === "settled") {
      searchParams.archived = true;
    }

    let response: PolymarketEvent[];
    try {
      response = await ky
        .get(`${BASE_URL}/events`, {
          searchParams,
          timeout: 30000,
          retry: {
            limit: 3,
            methods: ["get"],
            statusCodes: [408, 429, 500, 502, 503, 504],
            delay: (attemptCount) => Math.min(1000 * 2 ** attemptCount, 10000),
          },
        })
        .json<PolymarketEvent[]>();
    } catch (error) {
      recordExternalApiFailure("polymarket", error);
      throw error;
    }

    const events = Array.isArray(response) ? response : [];

    if (events.length === 0) break;

    // Extract markets from events, inheriting tags from parent event
    for (const event of events) {
      const markets = (event.markets ?? []).map((m) => ({
        ...m,
        // Inherit tags from event if market doesn't have them
        tags: m.tags ?? event.tags,
      }));

      const filteredMarkets = markets.filter((m) =>
        shouldIncludeMarket(m, status, excludeSports)
      );

      allMarkets.push(...filteredMarkets);

      if (allMarkets.length >= limit) break;
    }

    offset += PAGE_SIZE;

    // Small delay to respect rate limits
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return allMarkets.slice(0, limit);
}

export async function fetchPolymarketMarkets(
  options: {
    limit?: number;
    excludeSports?: boolean;
    status?: PolymarketFetchStatus;
  } = {}
): Promise<PolymarketMarket[]> {
  const { limit = 500, excludeSports = true, status = "open" } = options;

  const statuses: Array<Exclude<PolymarketFetchStatus, "all">> =
    status === "all" ? ["open", "closed", "settled"] : [status];

  const allMarkets: PolymarketMarket[] = [];
  const seen = new Set<string>();

  for (const nextStatus of statuses) {
    const remaining = Math.max(limit - allMarkets.length, 0);
    if (remaining === 0) break;

    const batch = await fetchPolymarketMarketsByStatus(
      nextStatus,
      remaining,
      excludeSports
    );

    for (const market of batch) {
      if (seen.has(market.id)) continue;
      seen.add(market.id);
      allMarkets.push(market);
    }
  }

  return allMarkets.slice(0, limit);
}

export async function fetchPolymarketMarket(
  id: string
): Promise<PolymarketMarket | null> {
  try {
    return await ky
      .get(`${BASE_URL}/markets/${id}`, { timeout: 10000 })
      .json<PolymarketMarket>();
  } catch (error) {
    recordExternalApiFailure("polymarket", error);
    return null;
  }
}
