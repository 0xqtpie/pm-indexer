import ky from "ky";
import type { PolymarketMarket } from "../../types/polymarket.ts";

const BASE_URL = "https://gamma-api.polymarket.com";
const PAGE_SIZE = 100;

interface PolymarketListResponse {
  data?: PolymarketMarket[];
  // Sometimes the API returns an array directly
}

export async function fetchPolymarketMarkets(
  options: {
    closed?: boolean;
    limit?: number;
  } = {}
): Promise<PolymarketMarket[]> {
  const { closed = false, limit = 500 } = options;
  const allMarkets: PolymarketMarket[] = [];
  let offset = 0;

  while (allMarkets.length < limit) {
    const searchParams: Record<string, string | number | boolean> = {
      closed,
      limit: PAGE_SIZE,
      offset,
    };

    const response = await ky
      .get(`${BASE_URL}/markets`, {
        searchParams,
        timeout: 30000,
        retry: {
          limit: 3,
          delay: (attemptCount) => Math.min(1000 * 2 ** attemptCount, 10000),
        },
      })
      .json<PolymarketMarket[] | PolymarketListResponse>();

    // Handle both array and object responses
    const markets = Array.isArray(response) ? response : response.data ?? [];

    if (markets.length === 0) break;

    allMarkets.push(...markets);
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
