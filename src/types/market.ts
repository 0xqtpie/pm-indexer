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
  subtitle?: string; // Choice label for multi-outcome markets (e.g., "Anthropic", "Above 50%")
  description: string;
  rules?: string;
  category?: string;
  tags: string[];

  // Content hash for change detection (SHA-256 of title + description + rules)
  contentHash: string;

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
  const parts = [market.title, market.description, market.rules].filter(Boolean);

  return parts.join("\n\n");
}

/**
 * Compute a content hash for change detection.
 * Uses SHA-256 of the embedding-relevant content.
 */
export async function computeContentHash(
  title: string,
  description: string,
  rules?: string
): Promise<string> {
  const content = [title, description, rules].filter(Boolean).join("\n");
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest("SHA-256", data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}
