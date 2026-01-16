import { HTTPError } from "ky";
import { recordExternalApiError } from "../../metrics.ts";
import type { ExternalApiErrorCategory, ExternalApiSource } from "../../metrics.ts";

export function classifyExternalApiError(error: unknown): ExternalApiErrorCategory {
  if (error && typeof error === "object") {
    const name = "name" in error ? String(error.name) : "";
    if (name === "TimeoutError") {
      return "timeout";
    }
  }

  if (error instanceof HTTPError) {
    const status = error.response.status;
    if (status === 429) {
      return "rate_limited";
    }
    if (status >= 500) {
      return "http_5xx";
    }
    if (status >= 400) {
      return "http_4xx";
    }
  }

  if (error instanceof TypeError) {
    return "network";
  }

  return "unknown";
}

export function recordExternalApiFailure(
  source: ExternalApiSource,
  error: unknown
): ExternalApiErrorCategory {
  const category = classifyExternalApiError(error);
  recordExternalApiError(source, category);
  return category;
}
