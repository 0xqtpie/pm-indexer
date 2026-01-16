import ky from "ky";
import type {
  KalshiMarket,
  KalshiEventsResponse,
} from "../../types/kalshi.ts";

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const PAGE_SIZE = 100;

export type KalshiFetchStatus = "open" | "closed" | "settled" | "all";

// Categories to exclude (sports betting)
const SPORTS_CATEGORIES = ["Sports"];

function shouldIncludeMarket(
  market: KalshiMarket,
  status: KalshiFetchStatus
): boolean {
  switch (status) {
    case "open":
      return market.status === "open" || market.status === "active";
    case "closed":
      return market.status === "closed";
    case "settled":
      return market.status === "settled";
    case "all":
      return true;
    default:
      return market.status === "open" || market.status === "active";
  }
}

async function fetchKalshiMarketsByStatus(
  status: Exclude<KalshiFetchStatus, "all">,
  limit: number,
  excludeSports: boolean
): Promise<KalshiMarket[]> {
  const allMarkets: KalshiMarket[] = [];
  let cursor: string | undefined;

  while (allMarkets.length < limit) {
    const searchParams: Record<string, string | number | boolean> = {
      status,
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

    for (const event of events) {
      if (excludeSports && SPORTS_CATEGORIES.includes(event.category)) {
        continue;
      }

      const markets = (event.markets ?? []).map((m) => ({
        ...m,
        category: event.category,
      }));

      const filteredMarkets = markets.filter((m) =>
        shouldIncludeMarket(m, status)
      );
      allMarkets.push(...filteredMarkets);

      if (allMarkets.length >= limit) break;
    }

    cursor = response.cursor;

    if (!cursor) break;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return allMarkets.slice(0, limit);
}

export async function fetchKalshiMarkets(
  options: {
    limit?: number;
    excludeSports?: boolean;
    status?: KalshiFetchStatus;
  } = {}
): Promise<KalshiMarket[]> {
  const { limit = 500, excludeSports = true, status = "open" } = options;

  const statuses: Array<Exclude<KalshiFetchStatus, "all">> =
    status === "all" ? ["open", "closed", "settled"] : [status];

  const allMarkets: KalshiMarket[] = [];
  const seen = new Set<string>();

  for (const nextStatus of statuses) {
    const remaining = Math.max(limit - allMarkets.length, 0);
    if (remaining === 0) break;

    const batch = await fetchKalshiMarketsByStatus(
      nextStatus,
      remaining,
      excludeSports
    );

    for (const market of batch) {
      if (seen.has(market.ticker)) continue;
      seen.add(market.ticker);
      allMarkets.push(market);
    }
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
