import ky from "ky";
import type {
  KalshiMarket,
  KalshiEventsResponse,
} from "../../types/kalshi.ts";

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const PAGE_SIZE = 100;

// Categories to exclude (sports betting)
const SPORTS_CATEGORIES = ["Sports"];

export async function fetchKalshiMarkets(
  options: {
    limit?: number;
    excludeSports?: boolean;
  } = {}
): Promise<KalshiMarket[]> {
  const { limit = 500, excludeSports = true } = options;
  const allMarkets: KalshiMarket[] = [];
  let cursor: string | undefined;

  // Always fetch open events only
  while (allMarkets.length < limit) {
    const searchParams: Record<string, string | number | boolean> = {
      status: "open", // Only open markets
      limit: PAGE_SIZE,
      with_nested_markets: true,
    };

    if (cursor) {
      searchParams.cursor = cursor;
    }

    const response = await ky
      .get(`${BASE_URL}/events`, {
        searchParams,
        timeout: 30000,
        retry: {
          limit: 3,
          delay: (attemptCount) => Math.min(1000 * 2 ** attemptCount, 10000),
        },
      })
      .json<KalshiEventsResponse>();

    const events = response.events ?? [];

    if (events.length === 0) break;

    // Filter events and extract markets
    for (const event of events) {
      // Skip sports if excludeSports is true
      if (excludeSports && SPORTS_CATEGORIES.includes(event.category)) {
        continue;
      }

      // Extract markets from event, adding category from parent event
      const markets = (event.markets ?? []).map((m) => ({
        ...m,
        category: event.category,
      }));

      // Only add active/open markets
      // Note: API returns "active" for open markets when using events endpoint
      const filteredMarkets = markets.filter((m) => m.status === "active");
      allMarkets.push(...filteredMarkets);

      if (allMarkets.length >= limit) break;
    }

    cursor = response.cursor;

    if (!cursor) break;

    // Small delay to respect rate limits
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return allMarkets.slice(0, limit);
}

export async function fetchKalshiMarket(
  ticker: string
): Promise<KalshiMarket | null> {
  try {
    const response = await ky
      .get(`${BASE_URL}/markets/${ticker}`, { timeout: 10000 })
      .json<{ market: KalshiMarket }>();
    return response.market;
  } catch {
    return null;
  }
}
