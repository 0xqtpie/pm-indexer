import { describe, test, expect } from "bun:test";
import { decodeCursor, encodeCursor } from "../src/api/pagination.ts";

describe("pagination cursor helpers", () => {
  test("round-trips cursor encoding", () => {
    const cursor = encodeCursor({ type: "offset", offset: 42, qHash: "abc" });
    const decoded = decodeCursor(cursor);

    expect(decoded).toEqual({ type: "offset", offset: 42, qHash: "abc" });
  });

  test("rejects invalid cursor payloads", () => {
    expect(decodeCursor("not-base64")).toBeNull();
    const invalid = Buffer.from(
      JSON.stringify({ type: "offset", offset: -1 }),
      "utf8"
    ).toString("base64");
    expect(decodeCursor(invalid)).toBeNull();
  });

  test("accepts keyset cursor payloads", () => {
    const cursor = encodeCursor({
      type: "keyset",
      sort: "createdAt",
      order: "desc",
      lastValue: "2024-01-01T00:00:00.000Z",
      lastId: "id-1",
    });

    const decoded = decodeCursor(cursor);
    expect(decoded).toEqual({
      type: "keyset",
      sort: "createdAt",
      order: "desc",
      lastValue: "2024-01-01T00:00:00.000Z",
      lastId: "id-1",
    });
  });
});
