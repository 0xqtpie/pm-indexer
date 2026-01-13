export interface PolymarketTag {
  id: string;
  slug: string;
  label: string;
}

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  startDate: string;
  endDate: string;
  closed: boolean;
  archived: boolean;
  image: string;
}

export interface PolymarketMarket {
  id: string;
  question: string;
  description: string;
  slug: string;
  conditionId: string;
  outcomes: string[];
  outcomePrices: string[];
  volume: string;
  volume24hr: string;
  liquidity: string;
  startDate: string;
  endDate: string;
  closed: boolean;
  active: boolean;
  archived: boolean;
  image: string;
  icon: string;
  tags?: PolymarketTag[];
  events?: PolymarketEvent[];
}

export interface PolymarketMarketsResponse {
  data: PolymarketMarket[];
  next_cursor?: string;
}

export interface PolymarketEventsResponse {
  data: PolymarketEvent[];
  next_cursor?: string;
}
