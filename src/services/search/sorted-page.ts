import type { SearchResult } from "./qdrant.ts";

export type SearchSort = "relevance" | "volume" | "closeAt";
export type SortOrder = "asc" | "desc";

export function sortSearchResults(
  results: SearchResult[],
  sort: SearchSort,
  order: SortOrder
): SearchResult[] {
  if (sort === "relevance") {
    return results;
  }

  const direction = order === "asc" ? 1 : -1;
  return [...results].sort((a, b) => {
    if (sort === "volume") {
      return (a.volume - b.volume) * direction;
    }
    if (sort === "closeAt") {
      const aValue = a.closeAt ?? "";
      const bValue = b.closeAt ?? "";
      if (aValue === bValue) return 0;
      return aValue < bValue ? -1 * direction : 1 * direction;
    }
    return 0;
  });
}

export function getSortedPage(
  results: SearchResult[],
  sort: SearchSort,
  order: SortOrder,
  limit: number,
  offset: number,
  window: number
): { page: SearchResult[]; nextOffset: number; hasMore: boolean } {
  if (offset >= window) {
    return { page: [], nextOffset: offset, hasMore: false };
  }

  const sorted = sortSearchResults(results, sort, order);
  const windowed = sorted.slice(0, window);
  const page = windowed.slice(offset, offset + limit);
  const nextOffset = offset + page.length;
  const hasMore = nextOffset < windowed.length;

  return { page, nextOffset, hasMore };
}
