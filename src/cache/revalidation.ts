import { createHmac } from "node:crypto";
import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "../db/client.js";
import { cacheRevalidations } from "../db/schema/cacheRevalidations.js";
import { env } from "../env.js";
import { logger as rootLogger } from "../logger.js";

export type RevalidationMode = "refresh" | "remove";
export type RevalidationChange = { tags: string[]; mode: RevalidationMode };

/** Website cache tags. Keep in sync with `src/lib/blog/public-blog.ts` in the web app. */
export const BLOG_LIST_TAG = "blog";
export const blogPostTag = (slug: string) => `blog:${slug}`;

type PublicState = { status: string; slug: string };

/**
 * Which public cache entries a post change touches. Drafts and scheduled posts are
 * invisible to the public site, so changes that never involve a published state need
 * no purge. Leaving the published state (or changing a live slug) must remove the
 * old entry immediately; other changes can be served stale while they refresh.
 */
export function revalidationForPostChange(before: PublicState | null, after: PublicState | null): RevalidationChange | null {
  const wasPublic = before?.status === "published";
  const isPublic = after?.status === "published";
  if (!wasPublic && !isPublic) return null;
  const tags = new Set<string>([BLOG_LIST_TAG]);
  if (before && wasPublic) tags.add(blogPostTag(before.slug));
  if (after) tags.add(blogPostTag(after.slug));
  const removesSomething = wasPublic && (!isPublic || before?.slug !== after?.slug);
  return { tags: [...tags], mode: removesSomething ? "remove" : "refresh" };
}

/** Website cache tag for the public reviews list. Keep in sync with the web app's review fetcher. */
export const REVIEWS_TAG = "reviews";

/**
 * Which public cache entries a review change touches. A review leaving the site
 * (unpublished or deleted, `after` null) must disappear at once; other changes to a
 * published review can be served stale while they refresh.
 */
export function revalidationForReviewChange(before: { status: string } | null, after: { status: string } | null): RevalidationChange | null {
  const wasPublic = before?.status === "published";
  const isPublic = after?.status === "published";
  if (!wasPublic && !isPublic) return null;
  return { tags: [REVIEWS_TAG], mode: wasPublic && !isPublic ? "remove" : "refresh" };
}

type Insertable = Pick<ReturnType<typeof getDb>, "insert">;

export async function queueRevalidation(executor: Insertable, change: RevalidationChange) {
  await executor.insert(cacheRevalidations).values({ tags: change.tags, mode: change.mode });
}

/** Signature over `timestamp.body`; the website rejects stale timestamps to limit replay. */
export function signRevalidation(secret: string, timestamp: string, body: string) {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export const MAX_REVALIDATION_ATTEMPTS = 8;

export function nextRetryDelayMs(attempts: number) {
  return Math.min(10_000 * 2 ** Math.max(0, attempts - 1), 15 * 60_000);
}

export type RevalidationTarget = { url: string; secret: string };

export async function sendRevalidation(
  target: RevalidationTarget,
  change: RevalidationChange,
  fetchImpl: typeof fetch = fetch,
  now = Date.now(),
) {
  const body = JSON.stringify(change);
  const timestamp = String(Math.floor(now / 1000));
  const response = await fetchImpl(target.url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Revalidate-Timestamp": timestamp,
      "X-Revalidate-Signature": signRevalidation(target.secret, timestamp, body),
    },
    body,
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok) throw new Error(`Website revalidation returned ${response.status}.`);
}

/**
 * Claims due rows with SKIP LOCKED so several API processes can share the outbox
 * without double-sending, then records the outcome in the same transaction.
 */
export async function dispatchDueRevalidations(target: RevalidationTarget, logger: Logger, fetchImpl: typeof fetch = fetch) {
  return getDb().transaction(async (tx) => {
    const due = await tx
      .select()
      .from(cacheRevalidations)
      .where(and(eq(cacheRevalidations.status, "pending"), lte(cacheRevalidations.availableAt, sql`now()`)))
      .orderBy(cacheRevalidations.createdAt)
      .limit(10)
      .for("update", { skipLocked: true });
    let sent = 0;
    for (const row of due) {
      const attempts = row.attempts + 1;
      try {
        await sendRevalidation(target, { tags: row.tags, mode: row.mode as RevalidationMode }, fetchImpl);
        await tx
          .update(cacheRevalidations)
          .set({ status: "sent", attempts, sentAt: new Date(), lastError: null })
          .where(eq(cacheRevalidations.id, row.id));
        sent += 1;
      } catch (error) {
        const deadLetter = attempts >= MAX_REVALIDATION_ATTEMPTS;
        const message = (error instanceof Error ? error.message : "Revalidation failed.").slice(0, 500);
        await tx
          .update(cacheRevalidations)
          .set({
            status: deadLetter ? "dead_letter" : "pending",
            attempts,
            lastError: message,
            availableAt: new Date(Date.now() + nextRetryDelayMs(attempts)),
          })
          .where(eq(cacheRevalidations.id, row.id));
        logger.warn({ revalidationId: row.id, attempts, deadLetter, err: error }, "website cache revalidation failed");
      }
    }
    return { claimed: due.length, sent };
  });
}

export function revalidationTarget(): RevalidationTarget | null {
  if (!env.REVALIDATE_SECRET) return null;
  return {
    url: env.FRONTEND_REVALIDATE_URL ?? `${env.FRONTEND_ORIGIN.replace(/\/+$/, "")}/api/revalidate`,
    secret: env.REVALIDATE_SECRET,
  };
}

let wake: (() => void) | undefined;

/** Called after a commit that queued a revalidation so the purge goes out without waiting for the poll. */
export function notifyRevalidationQueued() {
  wake?.();
}

const POLL_INTERVAL_MS = 5_000;

export function startRevalidationDispatcher(logger: Logger = rootLogger.child({ component: "cache-revalidation" })) {
  const target = revalidationTarget();
  if (!target) {
    logger.warn("REVALIDATE_SECRET is not set; website cache purges stay queued and pages refresh hourly");
    return { close() {} };
  }
  let running = false;
  let rerun = false;
  async function tick() {
    if (running) {
      rerun = true;
      return;
    }
    running = true;
    try {
      do {
        rerun = false;
        await dispatchDueRevalidations(target!, logger);
      } while (rerun);
    } catch (error) {
      logger.error({ err: error }, "cache revalidation dispatch failed");
    } finally {
      running = false;
    }
  }
  wake = () => void tick();
  void tick();
  const timer = setInterval(() => void tick(), POLL_INTERVAL_MS);
  timer.unref();
  return {
    close() {
      clearInterval(timer);
      wake = undefined;
    },
  };
}

export async function countRevalidations() {
  const rows = await getDb()
    .select({ status: cacheRevalidations.status, total: sql<number>`count(*)::int` })
    .from(cacheRevalidations)
    .where(inArray(cacheRevalidations.status, ["pending", "dead_letter"]))
    .groupBy(cacheRevalidations.status);
  const byStatus = Object.fromEntries(rows.map((row) => [row.status, Number(row.total)]));
  return { pending: byStatus.pending ?? 0, deadLetter: byStatus.dead_letter ?? 0 };
}
