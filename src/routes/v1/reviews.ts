import { and, count, desc, eq, gte, ilike, or, sql, type SQL } from "drizzle-orm";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { auditContextFrom, recordAudit, type AuditContext } from "../../audit/audit.js";
import { notifyRevalidationQueued, queueRevalidation, revalidationForReviewChange } from "../../cache/revalidation.js";
import { getDb } from "../../db/client.js";
import { reviews, type Review } from "../../db/schema/reviews.js";
import {
  deleteConflicts,
  expectedUpdatedAtSchema,
  planReviewWrite,
  PUBLIC_REVIEW_LIMIT,
  reviewInputSchema,
  reviewPatchSchema,
  reviewStatuses,
  startOfWatYear,
  toPublicReview,
  type PublicReview,
  type ReviewInput,
  type ReviewPatch,
  type ReviewStatus,
} from "../../reviews/policy.js";
import { escapeLike, forbiddenOrigin, pageResult, pageSchema, trustedOrigin, uuidSchema, type PageQuery } from "./admin-shared.js";

type AdminVariables = { Variables: { admin: { id: string; email: string } } };

export type ReviewCounts = { published: number; publishedThisYear: number; draft: number };

export type CreateReviewResult = { kind: "created"; review: Review } | { kind: "consent-required" } | { kind: "future-date" };
export type UpdateReviewResult = { kind: "updated"; review: Review } | { kind: "not-found" } | { kind: "conflict" } | { kind: "consent-required" } | { kind: "future-date" };
export type DeleteReviewResult = { kind: "deleted" } | { kind: "not-found" } | { kind: "conflict" };

export type ReviewsRouterDependencies = {
  listReviews: (query: PageQuery & { status: ReviewStatus | "all" }) => Promise<{ items: Review[]; total: number }>;
  countReviews: () => Promise<ReviewCounts>;
  getReview: (id: string) => Promise<Review | null>;
  createReview: (input: ReviewInput, audit: AuditContext) => Promise<CreateReviewResult>;
  updateReview: (id: string, patch: ReviewPatch, audit: AuditContext) => Promise<UpdateReviewResult>;
  deleteReview: (id: string, expectedUpdatedAt: string, audit: AuditContext) => Promise<DeleteReviewResult>;
};

export type PublicReviewsDependencies = {
  listPublishedReviews: () => Promise<PublicReview[]>;
};

const listQuerySchema = pageSchema.extend({ status: z.enum([...reviewStatuses, "all"]).default("all") });

/** Totals for the dashboard; "this year" is the calendar year in WAT. */
export async function countReviews(now = new Date()): Promise<ReviewCounts> {
  const db = getDb();
  const published = eq(reviews.status, "published");
  const [publishedCount, thisYear, draftCount] = await Promise.all([
    db.select({ total: count() }).from(reviews).where(published),
    db.select({ total: count() }).from(reviews).where(and(published, gte(reviews.publishedAt, startOfWatYear(now)))),
    db.select({ total: count() }).from(reviews).where(eq(reviews.status, "draft")),
  ]);
  return {
    published: Number(publishedCount[0]?.total ?? 0),
    publishedThisYear: Number(thisYear[0]?.total ?? 0),
    draft: Number(draftCount[0]?.total ?? 0),
  };
}

function buildProductionDependencies(): ReviewsRouterDependencies & PublicReviewsDependencies {
  return {
    async listReviews(query) {
      const conditions: SQL[] = [];
      if (query.status !== "all") conditions.push(eq(reviews.status, query.status));
      if (query.query) {
        const search = `%${escapeLike(query.query)}%`;
        conditions.push(or(ilike(reviews.displayName, search), ilike(reviews.quote, search))!);
      }
      const where = conditions.length ? and(...conditions) : undefined;
      const db = getDb();
      const [items, totals] = await Promise.all([
        db.select().from(reviews).where(where).orderBy(desc(reviews.updatedAt)).limit(query.pageSize).offset((query.page - 1) * query.pageSize),
        db.select({ total: count() }).from(reviews).where(where),
      ]);
      return { items, total: Number(totals[0]?.total ?? 0) };
    },
    countReviews,
    async getReview(id) {
      const [review] = await getDb().select().from(reviews).where(eq(reviews.id, id)).limit(1);
      return review ?? null;
    },
    async createReview(input, audit) {
      return getDb().transaction(async (tx): Promise<CreateReviewResult> => {
        const plan = planReviewWrite(null, input, { now: new Date(), actorId: audit.actorId });
        if (plan.kind === "consent-required" || plan.kind === "future-date") return plan;
        if (plan.kind !== "apply") throw new Error("A new review cannot conflict with an earlier version.");
        const [review] = await tx
          .insert(reviews)
          .values({ displayName: input.displayName, quote: input.quote, source: input.source, ...plan.values })
          .returning();
        if (!review) throw new Error("Review insert returned no row.");
        await recordAudit(tx, audit, { action: plan.action, entityType: "review", entityId: review.id, metadata: { status: plan.statusTo, fields: plan.fields } });
        const revalidation = revalidationForReviewChange(null, review);
        if (revalidation) await queueRevalidation(tx, revalidation);
        return { kind: "created", review };
      }).then(notifyAfterCommit);
    },
    async updateReview(id, patch, audit) {
      return getDb().transaction(async (tx): Promise<UpdateReviewResult> => {
        const [existing] = await tx.select().from(reviews).where(eq(reviews.id, id)).for("update");
        if (!existing) return { kind: "not-found" };
        const { expectedUpdatedAt, ...input } = patch;
        const plan = planReviewWrite(existing, input, { now: new Date(), actorId: audit.actorId, expectedUpdatedAt });
        if (plan.kind !== "apply") return plan;
        const [review] = await tx.update(reviews).set(plan.values).where(eq(reviews.id, id)).returning();
        if (!review) return { kind: "not-found" };
        await recordAudit(tx, audit, {
          action: plan.action,
          entityType: "review",
          entityId: id,
          metadata: { fields: plan.fields, ...(plan.statusFrom !== plan.statusTo ? { statusFrom: plan.statusFrom, statusTo: plan.statusTo } : {}) },
        });
        const revalidation = revalidationForReviewChange(existing, review);
        if (revalidation) await queueRevalidation(tx, revalidation);
        return { kind: "updated", review };
      }).then(notifyAfterCommit);
    },
    async deleteReview(id, expectedUpdatedAt, audit) {
      return getDb().transaction(async (tx): Promise<DeleteReviewResult> => {
        const [existing] = await tx.select().from(reviews).where(eq(reviews.id, id)).for("update");
        if (!existing) return { kind: "not-found" };
        if (deleteConflicts(existing, expectedUpdatedAt)) return { kind: "conflict" };
        await tx.delete(reviews).where(eq(reviews.id, id));
        // The customer's words and name are not copied into the audit trail.
        await recordAudit(tx, audit, { action: "review.delete", entityType: "review", entityId: id, metadata: { statusFrom: existing.status } });
        const revalidation = revalidationForReviewChange(existing, null);
        if (revalidation) await queueRevalidation(tx, revalidation);
        return { kind: "deleted" };
      }).then(notifyAfterCommit);
    },
    async listPublishedReviews() {
      const rows = await getDb()
        .select()
        .from(reviews)
        .where(eq(reviews.status, "published"))
        .orderBy(desc(reviews.featured), sql`${reviews.receivedOn} DESC NULLS LAST`, desc(reviews.publishedAt))
        .limit(PUBLIC_REVIEW_LIMIT);
      return rows.map(toPublicReview);
    },
  };
}

/** Wake the cache dispatcher once the write (and its queued purge) has committed. */
function notifyAfterCommit<T extends { kind: string }>(result: T) {
  if (result.kind === "created" || result.kind === "updated" || result.kind === "deleted") notifyRevalidationQueued();
  return result;
}

function invalidReview(context: Context) {
  return context.json({ success: false as const, message: "Please check the review details and try again.", responseCode: 400 }, 400);
}

function writeRefused(context: Context, kind: "not-found" | "conflict" | "consent-required" | "future-date") {
  if (kind === "not-found") return context.json({ success: false as const, message: "Review not found.", responseCode: 404 }, 404);
  if (kind === "conflict") {
    return context.json({ success: false as const, message: "This review was changed by someone else. Reload to see the latest version.", responseCode: 409 }, 409);
  }
  if (kind === "consent-required") {
    return context.json({ success: false as const, message: "Confirm the customer agreed to publication before publishing this review.", responseCode: 422 }, 422);
  }
  return context.json({ success: false as const, message: "The date received cannot be in the future.", responseCode: 400 }, 400);
}

let productionDependencies: ReturnType<typeof buildProductionDependencies> | undefined;
const production = () => (productionDependencies ??= buildProductionDependencies());

/** Admin review management, mounted at `/v1/admin/reviews` behind the session check. */
export function createReviewsAdminRouter(dependencies: ReviewsRouterDependencies = production()) {
  const router = new Hono<AdminVariables>();

  router.get("/", async (context) => {
    const parsed = listQuerySchema.safeParse({
      page: context.req.query("page"),
      pageSize: context.req.query("pageSize"),
      query: context.req.query("query") || undefined,
      status: context.req.query("status") || undefined,
    });
    if (!parsed.success) return context.json({ success: false as const, message: "Invalid review filters.", responseCode: 400 }, 400);
    const [result, counts] = await Promise.all([dependencies.listReviews(parsed.data), dependencies.countReviews()]);
    return context.json({ success: true as const, message: "Reviews loaded.", responseCode: 200, data: { ...pageResult(result.items, result.total, parsed.data), counts } });
  });

  router.get("/:id", async (context) => {
    const id = uuidSchema.safeParse(context.req.param("id"));
    if (!id.success) return writeRefused(context, "not-found");
    const review = await dependencies.getReview(id.data);
    if (!review) return writeRefused(context, "not-found");
    return context.json({ success: true as const, message: "Review loaded.", responseCode: 200, data: review });
  });

  router.post("/", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const parsed = reviewInputSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return invalidReview(context);
    const result = await dependencies.createReview(parsed.data, auditContextFrom(context, context.get("admin").id));
    if (result.kind !== "created") return writeRefused(context, result.kind);
    return context.json({ success: true as const, message: "Review saved.", responseCode: 201, data: result.review }, 201);
  });

  router.patch("/:id", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = uuidSchema.safeParse(context.req.param("id"));
    if (!id.success) return writeRefused(context, "not-found");
    const parsed = reviewPatchSchema.safeParse(await context.req.json().catch(() => null));
    if (!parsed.success) return invalidReview(context);
    const result = await dependencies.updateReview(id.data, parsed.data, auditContextFrom(context, context.get("admin").id));
    if (result.kind !== "updated") return writeRefused(context, result.kind);
    return context.json({ success: true as const, message: "Review saved.", responseCode: 200, data: result.review });
  });

  router.delete("/:id", async (context) => {
    if (!trustedOrigin(context)) return forbiddenOrigin(context);
    const id = uuidSchema.safeParse(context.req.param("id"));
    if (!id.success) return writeRefused(context, "not-found");
    const expected = expectedUpdatedAtSchema.safeParse(context.req.query("expectedUpdatedAt"));
    if (!expected.success) return invalidReview(context);
    const result = await dependencies.deleteReview(id.data, expected.data, auditContextFrom(context, context.get("admin").id));
    if (result.kind !== "deleted") return writeRefused(context, result.kind);
    return context.json({ success: true as const, message: "Review deleted.", responseCode: 200, data: { deleted: true as const } });
  });

  return router;
}

/** Published reviews for the website, mounted at `/v1/reviews`. Public fields only. */
export function createPublicReviewsRouter(dependencies: PublicReviewsDependencies = production()) {
  const router = new Hono();
  router.get("/", async (context) => {
    const items = await dependencies.listPublishedReviews();
    return context.json({ success: true as const, message: "Published reviews loaded.", responseCode: 200, data: { items } });
  });
  return router;
}
