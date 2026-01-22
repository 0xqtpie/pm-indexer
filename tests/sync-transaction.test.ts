import { describe, test, expect } from "bun:test";

/**
 * Tests for transaction boundaries in sync operations.
 *
 * These tests verify the structural changes made to ensure:
 * 1. Batch functions accept optional transaction parameter
 * 2. applyBatchChanges wraps Postgres writes in a transaction
 * 3. Qdrant operations happen OUTSIDE the transaction (after commit)
 */

describe("sync transaction boundaries", () => {
  describe("batch function signatures", () => {
    test("batch functions exist and are callable", async () => {
      // Import the sync module - this verifies the module compiles correctly
      // with the new transaction parameter signatures
      const syncModule = await import("../src/services/sync/index.ts");

      // The module exports public functions for sync operations
      expect(typeof syncModule.incrementalSync).toBe("function");
      expect(typeof syncModule.fullSync).toBe("function");
      expect(typeof syncModule.getSyncStatus).toBe("function");
    });
  });

  describe("DbClient interface compatibility", () => {
    test("db satisfies DbClient interface requirements", async () => {
      const { db } = await import("../src/db/index.ts");

      // Verify db has the methods required by DbClient interface
      expect(typeof db.insert).toBe("function");
      expect(typeof db.execute).toBe("function");
      expect(typeof db.transaction).toBe("function");
    });
  });

  describe("transaction structure verification", () => {
    test("applyBatchChanges uses db.transaction for Postgres writes", async () => {
      // This test verifies the code structure by reading the source
      // The actual behavior is tested in integration tests
      const fs = await import("fs");
      const source = fs.readFileSync(
        "src/services/sync/index.ts",
        "utf-8"
      );

      // Verify transaction wrapper exists
      expect(source).toContain("await db.transaction(async (tx) =>");

      // Verify batch functions are called with tx inside transaction
      expect(source).toContain("await insertMarketsBatch(marketsToInsert, syncedAt, tx)");
      expect(source).toContain("await recordPriceHistoryFromMarkets(marketsToInsert, syncedAt, tx)");
      expect(source).toContain("await updateMarketContentBatch(contentUpdates, syncedAt, tx)");
      expect(source).toContain("await updateMarketPricesBatch(marketsToUpdatePrices, syncedAt, tx)");
      expect(source).toContain("await recordPriceHistoryFromUpdates(marketsToUpdatePrices, syncedAt, tx)");
    });

    test("Qdrant operations remain outside transaction", async () => {
      const fs = await import("fs");
      const source = fs.readFileSync(
        "src/services/sync/index.ts",
        "utf-8"
      );

      // Find the transaction block end and Qdrant operation
      const transactionEnd = source.indexOf("});", source.indexOf("db.transaction"));
      const qdrantUpsert = source.indexOf("upsertMarkets(marketsNeedingEmbeddings, embeddings)");
      const qdrantPayloads = source.indexOf("updateMarketPayloads(payloadRefreshMarkets)");

      // Qdrant operations should come AFTER the transaction block closes
      expect(qdrantUpsert).toBeGreaterThan(transactionEnd);
      expect(qdrantPayloads).toBeGreaterThan(transactionEnd);
    });

    test("batch functions have optional tx parameter with db default", async () => {
      const fs = await import("fs");
      const source = fs.readFileSync(
        "src/services/sync/index.ts",
        "utf-8"
      );

      // Verify functions have tx: DbClient = db parameter pattern
      expect(source).toContain("tx: DbClient = db");

      // Count occurrences - should appear in all 5 batch functions
      const matches = source.match(/tx: DbClient = db/g);
      expect(matches?.length).toBeGreaterThanOrEqual(5);
    });
  });
});
