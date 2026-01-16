import { describe, test, expect } from "bun:test";
import type { SearchResult } from "../src/services/search/qdrant.ts";
import { getSortedPage } from "../src/services/search/sorted-page.ts";

function buildResult(id: string, volume: number): SearchResult {
  return {
    id,
    score: 0.5,
    source: "polymarket",
    sourceId: id,
    title: `Title ${id}`,
    subtitle: null,
    description: "desc",
    status: "open",
    yesPrice: 0.5,
    noPrice: 0.5,
    volume,
    closeAt: null,
    url: "https://example.com",
    tags: [],
    category: null,
  };
}

describe("sorted paging window", () => {
  test("paginates without duplication inside the window", () => {
    const results = [
      buildResult("a", 10),
      buildResult("b", 50),
      buildResult("c", 30),
      buildResult("d", 40),
      buildResult("e", 20),
    ];

    const window = 5;
    const page1 = getSortedPage(results, "volume", "desc", 2, 0, window).page;
    const page2 = getSortedPage(results, "volume", "desc", 2, 2, window).page;

    const combinedIds = [...page1, ...page2].map((r) => r.id);
    expect(new Set(combinedIds).size).toBe(combinedIds.length);

    const expectedOrder = ["b", "d", "c", "e", "a"];
    expect(combinedIds).toEqual(expectedOrder.slice(0, combinedIds.length));
  });

  test("returns empty page when offset exceeds window", () => {
    const results = [
      buildResult("a", 10),
      buildResult("b", 50),
      buildResult("c", 30),
    ];

    const page = getSortedPage(results, "volume", "desc", 2, 5, 3).page;
    expect(page).toHaveLength(0);
  });
});
