import { describe, test, expect } from "bun:test";
import type { SyncResult } from "../src/services/sync/index.ts";
import { summarizeSyncResults } from "../src/services/sync/index.ts";

function buildSyncResult(source: "polymarket" | "kalshi"): SyncResult {
  return {
    source,
    fetched: 10,
    newMarkets: 2,
    updatedPrices: 3,
    contentChanged: 1,
    embeddingsGenerated: 2,
    errors: [],
    durationMs: 5,
    status: "success",
  };
}

describe("sync error propagation", () => {
  test("marks partial status when a source fails", () => {
    const ok = buildSyncResult("polymarket");
    const results: Array<PromiseSettledResult<SyncResult>> = [
      { status: "fulfilled", value: ok },
      { status: "rejected", reason: new Error("kalshi down") },
    ];

    const { result, status, errors } = summarizeSyncResults(results, Date.now());

    expect(status).toBe("partial");
    expect(result.polymarket.status).toBe("success");
    expect(result.kalshi.status).toBe("failed");
    expect(errors).toContain("kalshi down");
  });
});
