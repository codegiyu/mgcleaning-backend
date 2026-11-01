import { and, eq, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { recordAudit } from "../audit/audit.js";
import { notifyRevalidationQueued, queueRevalidation, revalidationForPostChange } from "../cache/revalidation.js";
import { getDb } from "../db/client.js";
import { blogPosts } from "../db/schema/blogPosts.js";
import { logger as rootLogger } from "../logger.js";

const SWEEP_INTERVAL_MS = 30_000;

/**
 * Publishes every scheduled post whose time has come. The conditional UPDATE is the
 * whole concurrency story: a second sweeper, a retry, or an editor who unscheduled the
 * post first all leave the row unmatched, so each post is published at most once. The
 * clock is Postgres's `now()`, not this process's.
 */
export async function publishDueScheduledPosts() {
  const published = await getDb().transaction(async (tx) => {
    const rows = await tx
      .update(blogPosts)
      .set({
        status: "published",
        publishedAt: sql`${blogPosts.publishAt}`,
        publishAt: null,
        updatedAt: sql`now()`,
      })
      .where(and(eq(blogPosts.status, "scheduled"), lte(blogPosts.publishAt, sql`now()`)))
      .returning({ id: blogPosts.id, slug: blogPosts.slug, status: blogPosts.status, publishedAt: blogPosts.publishedAt });
    for (const post of rows) {
      await recordAudit(tx, { actorId: null, ipHash: null, requestId: null }, {
        action: "post.publish",
        entityType: "blog_post",
        entityId: post.id,
        metadata: { slug: post.slug, scheduled: true, publishedAt: post.publishedAt?.toISOString() ?? null },
      });
      const revalidation = revalidationForPostChange({ status: "scheduled", slug: post.slug }, post);
      if (revalidation) await queueRevalidation(tx, revalidation);
    }
    return rows;
  });
  if (published.length) notifyRevalidationQueued();
  return published;
}

export function startScheduledPublisher(logger: Logger = rootLogger.child({ component: "scheduled-publisher" })) {
  async function tick() {
    try {
      const published = await publishDueScheduledPosts();
      if (published.length) logger.info({ postIds: published.map((post) => post.id) }, "scheduled articles published");
    } catch (error) {
      logger.error({ err: error }, "scheduled publishing failed");
    }
  }
  void tick();
  const timer = setInterval(() => void tick(), SWEEP_INTERVAL_MS);
  timer.unref();
  return { close: () => clearInterval(timer) };
}
