import { Hono } from "hono";
import { getMetrics } from "../../metrics.ts";
import { requireAdminKey } from "../middleware.ts";
import { checkQdrantHealth } from "../../services/search/qdrant.ts";

const router = new Hono();

// Health check (basic liveness)
router.get("/health", (c) => {
  return c.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Readiness check (includes dependency health)
router.get("/ready", async (c) => {
  const qdrantOk = await checkQdrantHealth();

  if (!qdrantOk) {
    return c.json(
      {
        status: "unhealthy",
        qdrant: false,
        timestamp: new Date().toISOString(),
      },
      503
    );
  }

  return c.json({
    status: "healthy",
    qdrant: true,
    timestamp: new Date().toISOString(),
  });
});

// Metrics endpoint
router.get("/metrics", requireAdminKey, (c) => {
  return c.json(getMetrics());
});

export default router;
