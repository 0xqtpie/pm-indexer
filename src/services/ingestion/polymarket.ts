import ky from "ky";
import type { PolymarketMarket, PolymarketEvent } from "../../types/polymarket.ts";

const BASE_URL = "https://gamma-api.polymarket.com";
const PAGE_SIZE = 100;

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

export async function fetchPolymarketMarkets(
  options: {
    limit?: number;
    excludeSports?: boolean;
  } = {}
): Promise<PolymarketMarket[]> {
  const { limit = 500, excludeSports = true } = options;
  const allMarkets: PolymarketMarket[] = [];
  let offset = 0;

  // Always fetch open markets only
  while (allMarkets.length < limit) {
    const searchParams: Record<string, string | number | boolean> = {
      closed: false, // Only open markets
      limit: PAGE_SIZE,
      offset,
    };

    const response = await ky
      .get(`${BASE_URL}/events`, {
        searchParams,
        timeout: 30000,
        retry: {
          limit: 3,
          delay: (attemptCount) => Math.min(1000 * 2 ** attemptCount, 10000),
        },
      })
      .json<PolymarketEvent[]>();

    const events = Array.isArray(response) ? response : [];

    if (events.length === 0) break;

    // Extract markets from events, inheriting tags from parent event
    for (const event of events) {
      const markets = (event.markets ?? []).map((m) => ({
        ...m,
        // Inherit tags from event if market doesn't have them
        tags: m.tags ?? event.tags,
      }));

      // Filter: only open markets (not closed or archived), optionally exclude sports
      const filteredMarkets = markets.filter((m) => {
        if (m.closed) return false; // Skip closed markets
        if (m.archived) return false; // Skip archived markets
        if (excludeSports && isSportsMarket(m)) return false;
        return true;
      });

      allMarkets.push(...filteredMarkets);

      if (allMarkets.length >= limit) break;
    }

    offset += PAGE_SIZE;

    // Small delay to respect rate limits
    await new Promise((resolve) => setTimeout(resolve, 100));
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
  } catch {
    return null;
  }
}
