import type { NormalizedMarket } from "../../types/market.ts";
import type { Market } from "../../db/schema.ts";

export interface MarketPriceUpdate {
  id: string;
  yesPrice: number;
  noPrice: number;
  volume: number;
  volume24h: number;
  status: Market["status"];
}

export type ExistingMarket = Pick<Market, "id" | "sourceId" | "contentHash">;

export interface CategorizedMarkets {
  marketsToInsert: NormalizedMarket[];
  marketsToUpdatePrices: MarketPriceUpdate[];
  marketsNeedingEmbeddings: NormalizedMarket[];
  newMarkets: number;
  updatedPrices: number;
  contentChanged: number;
}

export function categorizeMarkets(
  normalizedMarkets: NormalizedMarket[],
  existingBySourceId: Map<string, ExistingMarket>
): CategorizedMarkets {
  const marketsToInsert: NormalizedMarket[] = [];
  const marketsToUpdatePrices: MarketPriceUpdate[] = [];
  const marketsNeedingEmbeddings: NormalizedMarket[] = [];

  let newMarkets = 0;
  let updatedPrices = 0;
  let contentChanged = 0;

  for (const market of normalizedMarkets) {
    const existing = existingBySourceId.get(market.sourceId);

    if (!existing) {
      marketsToInsert.push(market);
      marketsNeedingEmbeddings.push(market);
      newMarkets++;
      continue;
    }

    if (market.id !== existing.id) {
      market.id = existing.id;
    }

    marketsToUpdatePrices.push({
      id: existing.id,
      yesPrice: market.yesPrice,
      noPrice: market.noPrice,
      volume: market.volume,
      volume24h: market.volume24h,
      status: market.status,
    });
    updatedPrices++;

    if (existing.contentHash !== market.contentHash) {
      // Preserve ID for updates and re-embedding.
      market.id = existing.id;
      marketsNeedingEmbeddings.push(market);
      contentChanged++;
    }
  }

  return {
    marketsToInsert,
    marketsToUpdatePrices,
    marketsNeedingEmbeddings,
    newMarkets,
    updatedPrices,
    contentChanged,
  };
}
