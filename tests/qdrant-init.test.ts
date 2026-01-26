import { describe, test, expect } from "bun:test";
import { search } from "../src/services/search/qdrant.ts";
import { EMBEDDING_DIMENSIONS } from "../src/services/embedding/openrouter.ts";

describe("Qdrant initialization", () => {
  test("search ensures collection exists", async () => {
    const embedding = Array.from({ length: EMBEDDING_DIMENSIONS }, () => 0);
    const results = await search(embedding, {}, 1);
    expect(Array.isArray(results)).toBe(true);
  });
});
