export type CursorPayload =
  | {
      type: "offset";
      offset: number;
      qHash?: string;
    }
  | {
      type: "keyset";
      sort: string;
      order: "asc" | "desc";
      lastValue: string | number | null;
      lastId: string;
    };

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as CursorPayload;

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    if (parsed.type === "offset") {
      if (typeof parsed.offset !== "number" || parsed.offset < 0) {
        return null;
      }
      if (parsed.qHash !== undefined && typeof parsed.qHash !== "string") {
        return null;
      }
      return parsed;
    }

    if (parsed.type === "keyset") {
      if (parsed.order !== "asc" && parsed.order !== "desc") {
        return null;
      }
      if (typeof parsed.sort !== "string") {
        return null;
      }
      if (typeof parsed.lastId !== "string" || parsed.lastId.length === 0) {
        return null;
      }
      if (
        parsed.lastValue !== null &&
        typeof parsed.lastValue !== "string" &&
        typeof parsed.lastValue !== "number"
      ) {
        return null;
      }
      return parsed;
    }

    return null;
  } catch {
    return null;
  }
}
