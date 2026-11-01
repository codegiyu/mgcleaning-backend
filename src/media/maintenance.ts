import { and, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "../db/client.js";
import { mediaAssets } from "../db/schema/mediaAssets.js";
import { logger as rootLogger } from "../logger.js";
import { getMediaStorage, MediaStorageUnavailableError, type MediaStorage } from "../storage/r2.js";

const MAINTENANCE_INTERVAL_MS = 10 * 60_000;
const REMOVAL_BATCH_SIZE = 50;

export type MediaMaintenanceDependencies = {
  storage: () => MediaStorage;
  /** Moves pending uploads past their expiry to `expired`; returns how many changed. */
  expireStalePending: () => Promise<number>;
  /** Expired, failed, or deleted rows whose object has not yet been removed from R2. */
  listObjectsToRemove: (limit: number) => Promise<Array<{ id: string; key: string }>>;
  markObjectRemoved: (id: string) => Promise<void>;
};

const productionDependencies: MediaMaintenanceDependencies = {
  storage: getMediaStorage,
  async expireStalePending() {
    const expired = await getDb()
      .update(mediaAssets)
      .set({ status: "expired", updatedAt: new Date() })
      .where(and(eq(mediaAssets.status, "pending"), lt(mediaAssets.expiresAt, sql`now()`)))
      .returning({ id: mediaAssets.id });
    return expired.length;
  },
  async listObjectsToRemove(limit) {
    return getDb()
      .select({ id: mediaAssets.id, key: mediaAssets.key })
      .from(mediaAssets)
      .where(and(inArray(mediaAssets.status, ["expired", "failed", "deleted"]), isNull(mediaAssets.objectRemovedAt)))
      .limit(limit);
  },
  async markObjectRemoved(id) {
    await getDb().update(mediaAssets).set({ objectRemovedAt: sql`now()` }).where(eq(mediaAssets.id, id));
  },
};

/**
 * Idempotent: deleting a missing R2 key succeeds, so overlapping runs or retries
 * after a crash are harmless. Verified assets are never touched; they form the media library.
 */
export async function runMediaMaintenance(
  dependencies: MediaMaintenanceDependencies = productionDependencies,
  logger: Logger = rootLogger,
) {
  const expired = await dependencies.expireStalePending();
  const storage = dependencies.storage();
  const candidates = await dependencies.listObjectsToRemove(REMOVAL_BATCH_SIZE);
  let removed = 0;
  for (const candidate of candidates) {
    try {
      await storage.delete(candidate.key);
      await dependencies.markObjectRemoved(candidate.id);
      removed += 1;
    } catch (error) {
      logger.warn({ err: error, mediaId: candidate.id }, "media object removal failed; will retry");
    }
  }
  return { expired, removed, attempted: candidates.length };
}

export function startMediaMaintenance(logger: Logger = rootLogger.child({ component: "media-maintenance" })) {
  async function tick() {
    try {
      const result = await runMediaMaintenance(productionDependencies, logger);
      if (result.expired || result.attempted) logger.info(result, "media maintenance completed");
    } catch (error) {
      if (error instanceof MediaStorageUnavailableError) return;
      logger.error({ err: error }, "media maintenance failed");
    }
  }
  void tick();
  const timer = setInterval(() => void tick(), MAINTENANCE_INTERVAL_MS);
  timer.unref();
  return { close: () => clearInterval(timer) };
}
