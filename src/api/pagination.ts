export interface CursorPayload {
  offset: number;
}

export function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
}

export function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const decoded = Buffer.from(cursor, "base64").toString("utf8");
    const parsed = JSON.parse(decoded) as CursorPayload;
    if (!parsed || typeof parsed.offset !== "number" || parsed.offset < 0) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}
