import { sql } from "drizzle-orm";
import { Hono } from "hono";
import { getDb } from "../../db/client.js";
import { lazyProducerConnection } from "../../queue/redis.js";
import { getRequestLogger } from "../../request-context.js";

export type ReadinessDependencies = {
  checkDatabase: () => Promise<void>;
  checkRedis: () => Promise<void>;
};

const CHECK_TIMEOUT_MS = 2_000;
const redis = lazyProducerConnection();

const productionDependencies: ReadinessDependencies = {
  async checkDatabase() {
    await getDb().execute(sql`select 1`);
  },
  async checkRedis() {
    await (await redis.get()).ping();
  },
};

export const closeReadinessRedis = () => redis.close();

function withTimeout(check: () => Promise<void>) {
  return Promise.race([
    check(),
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`check timed out after ${CHECK_TIMEOUT_MS} ms`)), CHECK_TIMEOUT_MS).unref()),
  ]);
}

/**
 * `GET /v1/health/ready`: can this instance serve real requests? Unlike `/health`
 * (process is up), it checks Postgres and Redis, so the orchestrator stops routing to an
 * instance that has lost either. Failure details go to the log, not the response.
 */
export function createReadinessRouter(dependencies: ReadinessDependencies = productionDependencies) {
  const router = new Hono();
  router.get("/", async (context) => {
    const names = ["database", "redis"] as const;
    const results = await Promise.allSettled([withTimeout(dependencies.checkDatabase), withTimeout(dependencies.checkRedis)]);
    const checks = Object.fromEntries(names.map((name, index) => [name, results[index]?.status === "fulfilled" ? "ok" : "failed"])) as Record<(typeof names)[number], "ok" | "failed">;
    const failed = names.filter((name) => checks[name] === "failed");
    if (failed.length) {
      getRequestLogger(context).warn({ checks, errors: results.map((result) => (result.status === "rejected" ? String(result.reason) : null)) }, "readiness check failed");
      return context.json({ success: false as const, message: `Not ready: ${failed.join(", ")} unavailable.`, responseCode: 503, data: { status: "not-ready" as const, checks } }, 503);
    }
    return context.json({ success: true as const, message: "API is ready.", responseCode: 200, data: { status: "ready" as const, checks } });
  });
  return router;
}
