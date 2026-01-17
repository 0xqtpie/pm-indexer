import ky from "ky";
import type {
  KalshiMarket,
  KalshiEventsResponse,
} from "../../types/kalshi.ts";
import { recordExternalApiFailure } from "./errors.ts";

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

async function* fetchKalshiMarketBatchesByStatus(
  status: Exclude<KalshiFetchStatus, "all">,
  limit: number,
  excludeSports: boolean
): AsyncGenerator<KalshiMarket[], void, void> {
  let cursor: string | undefined;
  let fetched = 0;

  while (fetched < limit) {
    const searchParams: Record<string, string | number | boolean> = {
      status,
      limit: PAGE_SIZE,
      with_nested_markets: true,
    };

    if (cursor) {
      searchParams.cursor = cursor;
    }

    let response: KalshiEventsResponse;
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
        .json<KalshiEventsResponse>();
    } catch (error) {
      recordExternalApiFailure("kalshi", error);
      throw error;
    }

    const events = response.events ?? [];

    if (events.length === 0) break;

    const batch: KalshiMarket[] = [];

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
      for (const market of filteredMarkets) {
        if (fetched + batch.length >= limit) break;
        batch.push(market);
      }

      if (fetched + batch.length >= limit) break;
    }

    cursor = response.cursor;

    if (batch.length > 0) {
      fetched += batch.length;
      yield batch;
    }

    if (!cursor) break;

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

async function fetchKalshiMarketsByStatus(
  status: Exclude<KalshiFetchStatus, "all">,
  limit: number,
  excludeSports: boolean
): Promise<KalshiMarket[]> {
  const allMarkets: KalshiMarket[] = [];
  for await (const batch of fetchKalshiMarketBatchesByStatus(
    status,
    limit,
    excludeSports
  )) {
    allMarkets.push(...batch);
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

export async function* streamKalshiMarkets(
  options: {
    limit?: number;
    excludeSports?: boolean;
    status?: KalshiFetchStatus;
  } = {}
): AsyncGenerator<KalshiMarket[], void, void> {
  const { limit = 500, excludeSports = true, status = "open" } = options;

  const statuses: Array<Exclude<KalshiFetchStatus, "all">> =
    status === "all" ? ["open", "closed", "settled"] : [status];

  let remaining = limit;

  for (const nextStatus of statuses) {
    if (remaining <= 0) break;
    for await (const batch of fetchKalshiMarketBatchesByStatus(
      nextStatus,
      remaining,
      excludeSports
    )) {
      if (batch.length === 0) continue;
      remaining -= batch.length;
      yield batch;
      if (remaining <= 0) break;
    }
  }
}

export async function fetchKalshiMarket(
  ticker: string
): Promise<KalshiMarket | null> {
  try {
    const response = await ky
      .get(`${BASE_URL}/markets/${ticker}`, { timeout: 10000 })
      .json<{ market: KalshiMarket }>();
    return response.market;
  } catch (error) {
    recordExternalApiFailure("kalshi", error);
    return null;
  }
}
