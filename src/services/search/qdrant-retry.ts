import { logger } from "../../logger.ts";

export interface RetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
}

/**
 * Wraps an async function with exponential backoff retry logic.
 * Uses jitter to avoid thundering herd problems.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { maxAttempts = 3, baseDelayMs = 100, maxDelayMs = 5000 } = options;

  let lastError: Error;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;
      if (attempt === maxAttempts) break;

      // Exponential backoff: baseDelay * 2^(attempt-1), capped at maxDelay
      const delay = Math.min(
        baseDelayMs * Math.pow(2, attempt - 1),
        maxDelayMs
      );
      // Add 10% jitter to avoid thundering herd
      const jitter = delay * 0.1 * Math.random();

      logger.warn("Qdrant operation retry", {
        attempt,
        maxAttempts,
        delayMs: Math.round(delay + jitter),
        error: lastError.message,
      });

      await Bun.sleep(delay + jitter);
    }
  }
  throw lastError!;
}
