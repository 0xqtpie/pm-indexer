import ky from "ky";
import type { KalshiMarket, KalshiMarketsResponse } from "../../types/kalshi.ts";

const BASE_URL = "https://api.elections.kalshi.com/trade-api/v2";
const PAGE_SIZE = 200;

export async function fetchKalshiMarkets(
  options: {
    status?: "unopened" | "open" | "closed" | "settled";
    limit?: number;
  } = {}
): Promise<KalshiMarket[]> {
  const { status = "open", limit = 500 } = options;
  const allMarkets: KalshiMarket[] = [];
  let cursor: string | undefined;

  while (allMarkets.length < limit) {
    const searchParams: Record<string, string | number> = {
      status,
      limit: PAGE_SIZE,
    };

    if (cursor) {
      searchParams.cursor = cursor;
    }

    const response = await ky
      .get(`${BASE_URL}/markets`, {
        searchParams,
        timeout: 30000,
        retry: {
          limit: 3,
          delay: (attemptCount) => Math.min(1000 * 2 ** attemptCount, 10000),
        },
      })
      .json<KalshiMarketsResponse>();

    const markets = response.markets ?? [];

    if (markets.length === 0) break;

    allMarkets.push(...markets);
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
