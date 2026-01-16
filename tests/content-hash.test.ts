import { describe, test, expect } from "bun:test";
import { computeContentHash } from "../src/types/market.ts";

describe("computeContentHash", () => {
  test("returns stable hash for same content", async () => {
    const hash1 = await computeContentHash("Title", "Description", "Rules");
    const hash2 = await computeContentHash("Title", "Description", "Rules");

    expect(hash1).toBe(hash2);
  });

  test("changes when content changes", async () => {
    const hash1 = await computeContentHash("Title", "Description", "Rules");
    const hash2 = await computeContentHash("Title", "Different", "Rules");

    expect(hash1).not.toBe(hash2);
  });
});
