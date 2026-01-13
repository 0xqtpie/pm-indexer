export type MarketSource = "polymarket" | "kalshi";

export type MarketStatus = "open" | "closed" | "settled";

export type MarketResult = "yes" | "no" | null;

export interface NormalizedMarket {
  // Identity
  id: string;
  sourceId: string;
  source: MarketSource;

  // Content (for embedding)
  title: string;
  description: string;
  rules?: string;
  category?: string;
  tags: string[];

  // Pricing
  yesPrice: number; // 0-1 probability
  noPrice: number;
  lastPrice?: number;

  // Volume
  volume: number; // in USD
  volume24h: number;
  liquidity?: number;

  // Status
  status: MarketStatus;
  result?: MarketResult;

  // Timestamps
  createdAt: Date;
  openAt?: Date;
  closeAt?: Date;
  expiresAt?: Date;

  // Metadata
  url: string;
  imageUrl?: string;

  // Search
  embedding?: number[];
  embeddingModel?: string;
  lastSyncedAt: Date;
}

export function buildEmbeddingText(market: NormalizedMarket): string {
  const parts = [
    market.title,
    market.description,
    market.rules,
    market.tags.join(", "),
    market.category,
  ].filter(Boolean);

  return parts.join("\n\n");
}
