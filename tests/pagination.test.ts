import { describe, test, expect } from "bun:test";
import { decodeCursor, encodeCursor } from "../src/api/pagination.ts";

describe("pagination cursor helpers", () => {
  test("round-trips cursor encoding", () => {
    const cursor = encodeCursor({ offset: 42 });
    const decoded = decodeCursor(cursor);

    expect(decoded).toEqual({ offset: 42 });
  });

  test("rejects invalid cursor payloads", () => {
    expect(decodeCursor("not-base64")).toBeNull();
    const invalid = Buffer.from(JSON.stringify({ offset: -1 }), "utf8").toString(
      "base64"
    );
    expect(decodeCursor(invalid)).toBeNull();
  });
});
