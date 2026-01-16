// Note: Events endpoint returns "active" instead of "open" for market status
export type KalshiMarketStatus = "unopened" | "open" | "active" | "closed" | "settled";

export interface KalshiMarket {
  ticker: string;
  event_ticker: string;
  title: string;
  subtitle: string;
  status: KalshiMarketStatus;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  yes_sub_title?: string; // Choice label for multi-outcome markets (e.g., "Anthropic")
  no_sub_title?: string;  // Usually "Not {yes_sub_title}" or same as yes_sub_title
  last_price: number;
  volume: number;
  volume_24h: number;
  open_interest: number;
  created_time: string;
  open_time: string;
  close_time: string;
  expiration_time: string;
  rules_primary: string;
  rules_secondary: string;
  category?: string;
  tags?: string[];
}

export interface KalshiEvent {
  event_ticker: string;
  series_ticker: string;
  title: string;
  subtitle: string;
  category: string;
  mutually_exclusive: boolean;
  strike_date?: string;
  markets?: KalshiMarket[]; // Nested markets when using with_nested_markets
}

export interface KalshiMarketsResponse {
  markets: KalshiMarket[];
  cursor?: string;
}

export interface KalshiEventsResponse {
  events: KalshiEvent[];
  cursor?: string;
}
