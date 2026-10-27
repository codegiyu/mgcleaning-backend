import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, ilike, isNull, lt, or, sql } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { normalizeAttributionValue } from "../../attribution.js";
import { auditContextFrom, changedFields, recordAudit, type AuditAction, type AuditContext } from "../../audit/audit.js";
import { env } from "../../env.js";
import { BLOG_POST_SLUG_CONSTRAINT, isUniqueViolation } from "../../db/errors.js";
import { getRequestLogger } from "../../request-context.js";
import { escapeLike, pageResult, parsePageQuery, trustedOrigin, uuidSchema, type PageQuery } from "./admin-shared.js";
import { createMediaRouter } from "./media.js";
import { createAccountRouter, type SessionActor } from "./account.js";
import { createOperationsRouter } from "./operations.js";
import { countRevalidations, notifyRevalidationQueued, queueRevalidation, revalidationForPostChange } from "../../cache/revalidation.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { allowLoginAttempt, clearLoginAttempts } from "../../auth/login-rate-limit.js";
import { getDb } from "../../db/client.js";
import { adminSessions } from "../../db/schema/adminSessions.js";
import { adminUsers } from "../../db/schema/adminUsers.js";
import { blogPosts } from "../../db/schema/blogPosts.js";
import { contactInquiries } from "../../db/schema/contactInquiries.js";
import { emailOutbox } from "../../db/schema/emailOutbox.js";
import { mediaAssets } from "../../db/schema/mediaAssets.js";

const SESSION_COOKIE = "mg_admin_session";
const SESSION_SECONDS = 60 * 60 * 12;
/** `last_used_at` is refreshed at most this often, so most requests stay read-only. */
const SESSION_TOUCH_SECONDS = 5 * 60;
const DUMMY_HASH = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

export const inquiryStatuses = ["new", "contacted", "quoted", "booked", "closed"] as const;
export type InquiryStatus = (typeof inquiryStatuses)[number];
export const postStatuses = ["draft", "scheduled", "published", "archived"] as const;
/** Scheduling is bounded so a typo in the year cannot park an article for decades. */
export const MAX_SCHEDULE_DAYS = 365;
export type PostStatus = (typeof postStatuses)[number];

export type AdminActor = { id: string; email: string };
type InquiryRecord = typeof contactInquiries.$inferSelect;
type BlogPostRecord = typeof blogPosts.$inferSelect;
export type LoginClient = { userAgent: string | null };
export type InquiryNotification = {
  kind: "internal" | "customer";
  status: "pending" | "processing" | "sent" | "failed" | "dead_letter";
  attempts: number;
  sentAt: Date | null;
};
type LoginResult =
  | { kind: "success"; actor: AdminActor; token: string }
  | { kind: "invalid" }
  | { kind: "rate-limited" };
export type UpdatePostResult =
  | { kind: "updated"; post: BlogPostRecord }
  | { kind: "not-found" }
  | { kind: "invalid-cover" }
  | { kind: "invalid-schedule"; message: string }
  | { kind: "incomplete"; missing: string[] };
export type CreatePostResult = { kind: "created"; post: BlogPostRecord } | { kind: "invalid-cover" };
/** The media row a post's cover points at, as seen inside the post's transaction. */
export type CoverAsset = { id: string; publicUrl: string; status: string };

export type AdminRouterDependencies = {
  login: (email: string, password: string, audit: AuditContext, client: LoginClient) => Promise<LoginResult>;
  resolveSession: (token: string) => Promise<SessionActor | null>;
  revokeSession: (token: string, audit: AuditContext) => Promise<void>;
  getOverview: () => Promise<{
    inquiryCounts: { total: number; new: number };
    postCounts: { draft: number; published: number };
    emailOutboxCounts?: { pending: number; failed: number; deadLetter: number };
    cacheRevalidationCounts?: { pending: number; deadLetter: number };
  }>;
  /** `source: "direct"` matches enquiries with no campaign source. */
  listInquiries: (query: PageQuery & { status: InquiryStatus | "all"; source?: string }) => Promise<{
    items: InquiryRecord[];
    total: number;
  }>;
  getInquiry: (id: string) => Promise<InquiryRecord | null>;
  /** Delivery state of the inquiry's emails; never includes addresses or provider error text. */
  getInquiryNotifications: (id: string) => Promise<InquiryNotification[]>;
  updateInquiry: (
    id: string,
    patch: { status?: InquiryStatus; internalNote?: string | null },
    audit: AuditContext,
  ) => Promise<InquiryRecord | null>;
  listPosts: (query: PageQuery & { status: PostStatus | "all" }) => Promise<{
    items: BlogPostRecord[];
    total: number;
  }>;
  getPost: (id: string) => Promise<BlogPostRecord | null>;
  createPost: (input: BlogPostInput, audit: AuditContext) => Promise<CreatePostResult>;
  /** Validates and applies the patch against a locked row so a concurrent edit cannot publish an incomplete post. */
  updatePost: (id: string, patch: BlogPostPatch, audit: AuditContext) => Promise<UpdatePostResult>;
  listPublishedPosts: (query: PageQuery & { category?: string }) => Promise<{
    items: BlogPostRecord[];
    total: number;
  }>;
  getPublishedPost: (slug: string) => Promise<BlogPostRecord | null>;
};

const blogPostInputSchema = z
  .object({
    title: z.string().trim().min(3).max(180),
    slug: z.string().trim().min(2).max(180).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    excerpt: z.string().trim().min(8).max(320),
    body: z.string().trim().min(20).max(20_000),
    category: z.string().trim().min(2).max(80),
    authorName: z.string().trim().min(2).max(120).default("M&G Cleaning Services"),
    serviceSlug: z.string().trim().min(2).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    coverMediaId: z.string().uuid().nullable().optional(),
    coverImageAlt: z.string().trim().max(250).optional(),
    seoTitle: z.string().trim().max(180).optional(),
    seoDescription: z.string().trim().max(320).optional(),
  })
  .strict();

const blogPostPatchSchema = blogPostInputSchema
  .partial()
  .extend({
    status: z.enum(postStatuses).optional(),
    publishAt: z.iso.datetime({ offset: true }).transform((value) => new Date(value)).optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

type BlogPostInput = z.infer<typeof blogPostInputSchema>;
type BlogPostPatch = z.infer<typeof blogPostPatchSchema>;

export function publishValidation(post: { authorName?: string | null; serviceSlug?: string | null; coverImageUrl?: string | null; coverImageAlt?: string | null }) {
  const missing: string[] = [];
  if (!post.authorName?.trim()) missing.push("author");
  if (!post.serviceSlug?.trim()) missing.push("related service");
  if (!post.coverImageUrl?.trim()) missing.push("cover image");
  if (!post.coverImageAlt?.trim()) missing.push("cover image alt text");
  return missing;
}

type PostPatchPlan =
  | { kind: "incomplete"; missing: string[] }
  | { kind: "invalid-cover" }
  | { kind: "invalid-schedule"; message: string }
  | { kind: "apply"; update: Partial<typeof blogPosts.$inferInsert>; action: AuditAction; statusFrom: string; statusTo: string };

/**
 * Pure decision for a post patch. The publish gate applies to the merged row
 * whenever the result is published, so clearing a cover on a live post is refused too.
 */
export function planPostPatch(existing: BlogPostRecord, patch: BlogPostPatch, now: Date, cover: CoverAsset | null): PostPatchPlan {
  const statusFrom = existing.status;
  const statusTo = patch.status ?? existing.status;
  const coverMediaId = patch.coverMediaId === undefined ? existing.coverMediaId : patch.coverMediaId;
  const coverChanged = coverMediaId !== existing.coverMediaId;
  const coverIsVerified = Boolean(coverMediaId && cover?.id === coverMediaId && cover.status === "verified");
  if (coverChanged && coverMediaId && !coverIsVerified) return { kind: "invalid-cover" };
  // The public URL always comes from the verified asset, never from the client.
  const coverImageUrl = coverIsVerified && cover ? cover.publicUrl : null;
  const publishAt = statusTo === "scheduled" ? (patch.publishAt ?? existing.publishAt) : null;
  if (statusTo === "scheduled") {
    if (!publishAt) return { kind: "invalid-schedule", message: "Choose a date and time to publish this article." };
    if (publishAt.getTime() <= now.getTime()) return { kind: "invalid-schedule", message: "Choose a publish time in the future." };
    if (publishAt.getTime() > now.getTime() + MAX_SCHEDULE_DAYS * 86_400_000) {
      return { kind: "invalid-schedule", message: "Articles can be scheduled up to a year ahead." };
    }
  }
  // A scheduled post must already be complete: the scheduler publishes it without an editor present.
  if (statusTo === "published" || statusTo === "scheduled") {
    const missing = publishValidation({ ...existing, ...patch, coverImageUrl });
    if (missing.length) return { kind: "incomplete", missing };
  }
  const update: Partial<typeof blogPosts.$inferInsert> = { ...patch, publishAt, updatedAt: now };
  if (coverChanged) update.coverImageUrl = coverImageUrl;
  if (statusTo === "published" && statusFrom !== "published") update.publishedAt = now;
  if (statusTo === "draft" || statusTo === "scheduled") update.publishedAt = null;
  let action: AuditAction = "post.update";
  const rescheduled = statusTo === "scheduled" && publishAt?.getTime() !== existing.publishAt?.getTime();
  if (statusTo !== statusFrom || rescheduled) {
    if (statusTo === "scheduled") action = "post.schedule";
    else if (statusTo === "published") action = "post.publish";
    else if (statusFrom === "published" && statusTo === "draft") action = "post.unpublish";
    else if (statusTo === "archived") action = "post.archive";
  }
  return { kind: "apply", update, action, statusFrom, statusTo };
}

const loginSchema = z.object({
  email: z.string().trim().email().max(320),
  password: z.string().min(1).max(200),
});
const inquiryPatchSchema = z
  .object({
    status: z.enum(inquiryStatuses).optional(),
    internalNote: z.string().trim().max(4_000).nullable().optional(),
  })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

function digestToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

async function createDatabaseSession(email: string, password: string, audit: AuditContext, client: LoginClient): Promise<LoginResult> {
  const permitted = await allowLoginAttempt(email);
  if (!permitted) return { kind: "rate-limited" };

  const normalizedEmail = email.toLowerCase();
  const [user] = await getDb()
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.email, normalizedEmail))
    .limit(1);
  const passwordIsValid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordIsValid) {
    // Only failures against a real account are audited: the per-email rate limit
    // bounds those rows, whereas unknown-email attempts could be generated without limit.
    if (user) {
      await recordAudit(getDb(), { ...audit, actorId: user.id }, {
        action: "auth.login_failed",
        entityType: "admin_user",
        entityId: user.id,
        metadata: { reason: "invalid_password" },
      });
    }
    return { kind: "invalid" };
  }
  await clearLoginAttempts(email);

  const token = randomBytes(32).toString("base64url");
  await getDb().transaction(async (tx) => {
    await tx.insert(adminSessions).values({
      userId: user.id,
      tokenHash: digestToken(token),
      expiresAt: new Date(Date.now() + SESSION_SECONDS * 1_000),
      userAgent: client.userAgent,
      ipHash: audit.ipHash,
    });
    await recordAudit(tx, { ...audit, actorId: user.id }, {
      action: "auth.login",
      entityType: "admin_user",
      entityId: user.id,
    });
  });

  return { kind: "success", actor: { id: user.id, email: user.email }, token };
}

async function resolveDatabaseSession(token: string): Promise<SessionActor | null> {
  const [session] = await getDb()
    .select({ id: adminUsers.id, email: adminUsers.email, sessionId: adminSessions.id, lastUsedAt: adminSessions.lastUsedAt })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
    .where(
      and(
        eq(adminSessions.tokenHash, digestToken(token)),
        gt(adminSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!session) return null;
  if (Date.now() - session.lastUsedAt.getTime() > SESSION_TOUCH_SECONDS * 1_000) {
    await getDb()
      .update(adminSessions)
      .set({ lastUsedAt: sql`now()` })
      .where(and(eq(adminSessions.id, session.sessionId), lt(adminSessions.lastUsedAt, sql`now() - make_interval(secs => ${SESSION_TOUCH_SECONDS})`)));
  }
  return { id: session.id, email: session.email, sessionId: session.sessionId };
}

async function revokeDatabaseSession(token: string, audit: AuditContext) {
  await getDb().transaction(async (tx) => {
    const revoked = await tx
      .delete(adminSessions)
      .where(eq(adminSessions.tokenHash, digestToken(token)))
      .returning({ userId: adminSessions.userId });
    if (!revoked.length) return;
    await recordAudit(tx, audit, {
      action: "auth.logout",
      entityType: "admin_user",
      entityId: revoked[0]?.userId ?? null,
    });
  });
}

type Transaction = Parameters<Parameters<ReturnType<typeof getDb>["transaction"]>[0]>[0];

/** FOR SHARE blocks a concurrent media delete until this post's transaction commits. */
async function lockCoverAsset(tx: Transaction, id: string): Promise<CoverAsset | null> {
  const [asset] = await tx
    .select({ id: mediaAssets.id, publicUrl: mediaAssets.publicUrl, status: mediaAssets.status })
    .from(mediaAssets)
    .where(eq(mediaAssets.id, id))
    .for("share");
  return asset ?? null;
}

function buildProductionDependencies(): AdminRouterDependencies {
  return {
    login: createDatabaseSession,
    resolveSession: resolveDatabaseSession,
    revokeSession: revokeDatabaseSession,
    async getOverview() {
      const db = getDb();
      const [inquiryTotals, newCount, draftCount, publishedCount, pendingEmails, failedEmails, deadLetterEmails] = await Promise.all([
        db.select({ total: count() }).from(contactInquiries),
        db.select({ total: count() }).from(contactInquiries).where(eq(contactInquiries.status, "new")),
        db.select({ total: count() }).from(blogPosts).where(eq(blogPosts.status, "draft")),
        db.select({ total: count() }).from(blogPosts).where(eq(blogPosts.status, "published")),
        db.select({ total: count() }).from(emailOutbox).where(eq(emailOutbox.status, "pending")),
        db.select({ total: count() }).from(emailOutbox).where(eq(emailOutbox.status, "failed")),
        db.select({ total: count() }).from(emailOutbox).where(eq(emailOutbox.status, "dead_letter")),
      ]);
      return {
        inquiryCounts: { total: Number(inquiryTotals[0]?.total ?? 0), new: Number(newCount[0]?.total ?? 0) },
        postCounts: { draft: Number(draftCount[0]?.total ?? 0), published: Number(publishedCount[0]?.total ?? 0) },
        emailOutboxCounts: {
          pending: Number(pendingEmails[0]?.total ?? 0),
          failed: Number(failedEmails[0]?.total ?? 0),
          deadLetter: Number(deadLetterEmails[0]?.total ?? 0),
        },
        cacheRevalidationCounts: await countRevalidations(),
      };
    },
    async listInquiries(query) {
      const conditions = [];
      if (query.status !== "all") conditions.push(eq(contactInquiries.status, query.status));
      if (query.source) conditions.push(query.source === "direct" ? isNull(contactInquiries.utmSource) : eq(contactInquiries.utmSource, query.source));
      if (query.query) {
        const search = `%${escapeLike(query.query)}%`;
        conditions.push(
          or(
            ilike(contactInquiries.name, search),
            ilike(contactInquiries.phone, search),
            ilike(contactInquiries.serviceInterest, search),
          )!,
        );
      }
      const where = conditions.length ? and(...conditions) : undefined;
      const db = getDb();
      const [items, totals] = await Promise.all([
        db
          .select()
          .from(contactInquiries)
          .where(where)
          .orderBy(desc(contactInquiries.createdAt))
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize),
        db.select({ total: count() }).from(contactInquiries).where(where),
      ]);
      return { items, total: Number(totals[0]?.total ?? 0) };
    },
    async getInquiryNotifications(id) {
      const rows = await getDb()
        .select({ kind: emailOutbox.kind, status: emailOutbox.status, attempts: emailOutbox.attempts, sentAt: emailOutbox.sentAt })
        .from(emailOutbox)
        .where(eq(emailOutbox.inquiryId, id))
        .orderBy(emailOutbox.kind);
      return rows as InquiryNotification[];
    },
    async getInquiry(id) {
      const [item] = await getDb()
        .select()
        .from(contactInquiries)
        .where(eq(contactInquiries.id, id))
        .limit(1);
      return item ?? null;
    },
    async updateInquiry(id, patch, audit) {
      return getDb().transaction(async (tx) => {
        const [existing] = await tx
          .select({ status: contactInquiries.status })
          .from(contactInquiries)
          .where(eq(contactInquiries.id, id))
          .for("update");
        if (!existing) return null;
        const [item] = await tx
          .update(contactInquiries)
          .set({ ...patch, updatedAt: new Date() })
          .where(eq(contactInquiries.id, id))
          .returning();
        if (!item) return null;
        await recordAudit(tx, audit, {
          action: "inquiry.update",
          entityType: "inquiry",
          entityId: id,
          metadata: {
            fields: changedFields(patch),
            ...(patch.status && patch.status !== existing.status ? { statusFrom: existing.status, statusTo: patch.status } : {}),
          },
        });
        return item;
      });
    },
    async listPosts(query) {
      const conditions = [];
      if (query.status !== "all") conditions.push(eq(blogPosts.status, query.status));
      if (query.query) {
        const search = `%${escapeLike(query.query)}%`;
        conditions.push(or(ilike(blogPosts.title, search), ilike(blogPosts.slug, search))!);
      }
      const where = conditions.length ? and(...conditions) : undefined;
      const db = getDb();
      const [items, totals] = await Promise.all([
        db
          .select()
          .from(blogPosts)
          .where(where)
          .orderBy(desc(blogPosts.updatedAt))
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize),
        db.select({ total: count() }).from(blogPosts).where(where),
      ]);
      return { items, total: Number(totals[0]?.total ?? 0) };
    },
    async getPost(id) {
      const [item] = await getDb().select().from(blogPosts).where(eq(blogPosts.id, id)).limit(1);
      return item ?? null;
    },
    async createPost(input, audit) {
      return getDb().transaction(async (tx): Promise<CreatePostResult> => {
        const cover = input.coverMediaId ? await lockCoverAsset(tx, input.coverMediaId) : null;
        if (input.coverMediaId && cover?.status !== "verified") return { kind: "invalid-cover" };
        const [post] = await tx
          .insert(blogPosts)
          .values({ ...input, serviceSlug: input.serviceSlug, authorName: input.authorName, coverMediaId: cover?.id ?? null, coverImageUrl: cover?.publicUrl ?? null, coverImageAlt: input.coverImageAlt ?? null, seoTitle: input.seoTitle ?? null, seoDescription: input.seoDescription ?? null })
          .returning();
        if (!post) throw new Error("Blog post insert returned no row.");
        await recordAudit(tx, audit, {
          action: "post.create",
          entityType: "blog_post",
          entityId: post.id,
          metadata: { slug: post.slug, ...(post.coverMediaId ? { coverMediaId: post.coverMediaId } : {}) },
        });
        return { kind: "created", post };
      });
    },
    async updatePost(id, patch, audit) {
      return getDb().transaction(async (tx): Promise<UpdatePostResult> => {
        const [existing] = await tx.select().from(blogPosts).where(eq(blogPosts.id, id)).for("update");
        if (!existing) return { kind: "not-found" };
        const coverMediaId = patch.coverMediaId === undefined ? existing.coverMediaId : patch.coverMediaId;
        const cover = coverMediaId ? await lockCoverAsset(tx, coverMediaId) : null;
        const plan = planPostPatch(existing, patch, new Date(), cover);
        if (plan.kind !== "apply") return plan;
        const [post] = await tx.update(blogPosts).set(plan.update).where(eq(blogPosts.id, id)).returning();
        if (!post) return { kind: "not-found" };
        await recordAudit(tx, audit, {
          action: plan.action,
          entityType: "blog_post",
          entityId: id,
          metadata: {
            slug: post.slug,
            fields: changedFields(patch),
            ...(plan.statusFrom !== plan.statusTo ? { statusFrom: plan.statusFrom, statusTo: plan.statusTo } : {}),
            ...(post.publishAt ? { publishAt: post.publishAt.toISOString() } : {}),
          },
        });
        const revalidation = revalidationForPostChange(existing, post);
        if (revalidation) await queueRevalidation(tx, revalidation);
        return { kind: "updated", post };
      }).then((result) => {
        if (result.kind === "updated") notifyRevalidationQueued();
        return result;
      });
    },
    async listPublishedPosts(query) {
      const conditions = [eq(blogPosts.status, "published")];
      if (query.category) conditions.push(eq(blogPosts.category, query.category));
      const where = and(...conditions);
      const db = getDb();
      const [items, totals] = await Promise.all([
        db
          .select()
          .from(blogPosts)
          .where(where)
          .orderBy(desc(blogPosts.publishedAt))
          .limit(query.pageSize)
          .offset((query.page - 1) * query.pageSize),
        db.select({ total: count() }).from(blogPosts).where(where),
      ]);
      return { items, total: Number(totals[0]?.total ?? 0) };
    },
    async getPublishedPost(slug) {
      const [post] = await getDb()
        .select()
        .from(blogPosts)
        .where(and(eq(blogPosts.slug, slug), eq(blogPosts.status, "published")))
        .limit(1);
      return post ?? null;
    },
  };
}

function invalidCover(context: Context) {
  return context.json({ success: false as const, message: "Choose an uploaded cover image that has finished processing.", responseCode: 400 }, 400);
}

function slugConflict(context: Context) {
  return context.json({ success: false as const, message: "That article URL is already in use.", responseCode: 409 }, 409);
}


export function createAdminRouter(
  dependencies = buildProductionDependencies(),
  mediaRouter = createMediaRouter(),
  accountRouter = createAccountRouter(),
  operationsRouter = createOperationsRouter(),
) {
  const router = new Hono<{ Variables: { admin: SessionActor } }>();

  router.use("*", async (context, next) => {
    if (context.req.path.endsWith("/auth/login") || context.req.path.endsWith("/auth/session")) return next();
    const token = getCookie(context, SESSION_COOKIE);
    const actor = token ? await dependencies.resolveSession(token) : null;
    if (!actor) {
      return context.json(
        { success: false as const, message: "Please sign in to continue.", responseCode: 401 },
        401,
      );
    }
    context.set("admin", actor);
    return next();
  });

  router.post("/auth/login", async (context) => {
    if (!trustedOrigin(context)) {
      return context.json({ success: false as const, message: "Request origin is not allowed.", responseCode: 403 }, 403);
    }
    const body = await context.req.json().catch(() => null);
    const parsed = loginSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ success: false as const, message: "Enter a valid email and password.", responseCode: 400 }, 400);
    }
    try {
      const result = await dependencies.login(parsed.data.email, parsed.data.password, auditContextFrom(context, null), {
        userAgent: context.req.header("user-agent")?.slice(0, 200) || null,
      });
      if (result.kind === "rate-limited") {
        return context.json({ success: false as const, message: "Too many sign-in attempts. Try again later.", responseCode: 429 }, 429);
      }
      if (result.kind === "invalid") {
        return context.json({ success: false as const, message: "Email or password is incorrect.", responseCode: 401 }, 401);
      }
      setCookie(context, SESSION_COOKIE, result.token, {
        httpOnly: true,
        secure: env.NODE_ENV === "production",
        sameSite: "Lax",
        path: "/api/v1/admin",
        maxAge: SESSION_SECONDS,
      });
      return context.json({ success: true as const, message: "Signed in.", responseCode: 200, data: result.actor });
    } catch (error) {
      getRequestLogger(context).error({ err: error }, "admin sign-in failed");
      return context.json({ success: false as const, message: "Sign-in is temporarily unavailable.", responseCode: 503 }, 503);
    }
  });

  router.get("/auth/session", async (context) => {
    const token = getCookie(context, SESSION_COOKIE);
    const actor = token ? await dependencies.resolveSession(token) : null;
    // The session ID stays server-side; the browser only needs to know who is signed in.
    const data = actor ? { authenticated: true as const, user: { id: actor.id, email: actor.email } } : { authenticated: false as const, user: null };
    return context.json({
      success: true as const,
      message: actor ? "Session is active." : "No active admin session.",
      responseCode: 200,
      data,
    });
  });

  router.post("/auth/logout", async (context) => {
    if (!trustedOrigin(context)) {
      return context.json({ success: false as const, message: "Request origin is not allowed.", responseCode: 403 }, 403);
    }
    const token = getCookie(context, SESSION_COOKIE);
    if (token) await dependencies.revokeSession(token, auditContextFrom(context, context.get("admin").id));
    deleteCookie(context, SESSION_COOKIE, { path: "/api/v1/admin", secure: env.NODE_ENV === "production", sameSite: "Lax" });
    return context.json({ success: true as const, message: "Signed out.", responseCode: 200, data: { signedOut: true } });
  });

  router.get("/overview", async (context) => {
    const data = await dependencies.getOverview();
    return context.json({ success: true as const, message: "Admin overview loaded.", responseCode: 200, data });
  });

  router.get("/inquiries", async (context) => {
    const parsed = parsePageQuery(context);
    const status = context.req.query("status") ?? "all";
    const rawSource = context.req.query("source");
    const source = rawSource ? normalizeAttributionValue(rawSource) : undefined;
    if (!parsed.success || !(status === "all" || inquiryStatuses.includes(status as InquiryStatus)) || (rawSource && !source)) {
      return context.json({ success: false as const, message: "Invalid inquiry filters.", responseCode: 400 }, 400);
    }
    const result = await dependencies.listInquiries({ ...parsed.data, status: status as InquiryStatus | "all", ...(source ? { source } : {}) });
    return context.json({ success: true as const, message: "Inquiries loaded.", responseCode: 200, data: pageResult(result.items, result.total, parsed.data) });
  });

  router.get("/inquiries/:id", async (context) => {
    const id = context.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return context.json({ success: false as const, message: "Inquiry not found.", responseCode: 404 }, 404);
    }
    const item = await dependencies.getInquiry(id);
    if (!item) return context.json({ success: false as const, message: "Inquiry not found.", responseCode: 404 }, 404);
    const notifications = await dependencies.getInquiryNotifications(id);
    return context.json({ success: true as const, message: "Inquiry loaded.", responseCode: 200, data: { ...item, notifications } });
  });

  router.patch("/inquiries/:id", async (context) => {
    if (!trustedOrigin(context)) {
      return context.json({ success: false as const, message: "Request origin is not allowed.", responseCode: 403 }, 403);
    }
    const id = context.req.param("id");
    const body = await context.req.json().catch(() => null);
    const parsed = inquiryPatchSchema.safeParse(body);
    if (!uuidSchema.safeParse(id).success || !parsed.success) {
      return context.json({ success: false as const, message: "Please check the inquiry update and try again.", responseCode: 400 }, 400);
    }
    const item = await dependencies.updateInquiry(id, parsed.data, auditContextFrom(context, context.get("admin").id));
    if (!item) return context.json({ success: false as const, message: "Inquiry not found.", responseCode: 404 }, 404);
    return context.json({ success: true as const, message: "Inquiry updated.", responseCode: 200, data: item });
  });

  router.get("/blog/posts", async (context) => {
    const parsed = parsePageQuery(context);
    const status = context.req.query("status") ?? "all";
    if (!parsed.success || !(status === "all" || postStatuses.includes(status as PostStatus))) {
      return context.json({ success: false as const, message: "Invalid post filters.", responseCode: 400 }, 400);
    }
    const result = await dependencies.listPosts({ ...parsed.data, status: status as PostStatus | "all" });
    return context.json({ success: true as const, message: "Blog posts loaded.", responseCode: 200, data: pageResult(result.items, result.total, parsed.data) });
  });

  router.get("/blog/posts/:id", async (context) => {
    const id = context.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return context.json({ success: false as const, message: "Blog post not found.", responseCode: 404 }, 404);
    }
    const post = await dependencies.getPost(id);
    if (!post) return context.json({ success: false as const, message: "Blog post not found.", responseCode: 404 }, 404);
    return context.json({ success: true as const, message: "Blog post loaded.", responseCode: 200, data: post });
  });

  router.post("/blog/posts", async (context) => {
    if (!trustedOrigin(context)) {
      return context.json({ success: false as const, message: "Request origin is not allowed.", responseCode: 403 }, 403);
    }
    const body = await context.req.json().catch(() => null);
    const parsed = blogPostInputSchema.safeParse(body);
    if (!parsed.success) {
      return context.json({ success: false as const, message: "Please check the article fields and try again.", responseCode: 400 }, 400);
    }
    try {
      const result = await dependencies.createPost(parsed.data, auditContextFrom(context, context.get("admin").id));
      if (result.kind === "invalid-cover") return invalidCover(context);
      return context.json({ success: true as const, message: "Draft created.", responseCode: 201, data: result.post }, 201);
    } catch (error) {
      if (isUniqueViolation(error, BLOG_POST_SLUG_CONSTRAINT)) return slugConflict(context);
      throw error;
    }
  });

  router.patch("/blog/posts/:id", async (context) => {
    if (!trustedOrigin(context)) {
      return context.json({ success: false as const, message: "Request origin is not allowed.", responseCode: 403 }, 403);
    }
    const id = context.req.param("id");
    const body = await context.req.json().catch(() => null);
    const parsed = blogPostPatchSchema.safeParse(body);
    if (!uuidSchema.safeParse(id).success || !parsed.success) {
      return context.json({ success: false as const, message: "Please check the article fields and try again.", responseCode: 400 }, 400);
    }
    let result: UpdatePostResult;
    try {
      result = await dependencies.updatePost(id, parsed.data, auditContextFrom(context, context.get("admin").id));
    } catch (error) {
      if (isUniqueViolation(error, BLOG_POST_SLUG_CONSTRAINT)) return slugConflict(context);
      throw error;
    }
    if (result.kind === "not-found") {
      return context.json({ success: false as const, message: "Blog post not found.", responseCode: 404 }, 404);
    }
    if (result.kind === "invalid-cover") return invalidCover(context);
    if (result.kind === "invalid-schedule") {
      return context.json({ success: false as const, message: result.message, responseCode: 400 }, 400);
    }
    if (result.kind === "incomplete") {
      return context.json({ success: false as const, message: `Add ${result.missing.join(", ")} before publishing this article.`, responseCode: 400 }, 400);
    }
    return context.json({ success: true as const, message: "Blog post updated.", responseCode: 200, data: result.post });
  });

  router.route("/media", mediaRouter);
  router.route("/account", accountRouter);
  router.route("/", operationsRouter);

  return router;
}

export const adminRouter = createAdminRouter();

export function createPublicBlogRouter(
  dependencies: Pick<AdminRouterDependencies, "listPublishedPosts" | "getPublishedPost"> =
    buildProductionDependencies(),
) {
  const router = new Hono();
  router.get("/", async (context) => {
    const parsed = parsePageQuery(context);
    const category = context.req.query("category");
    if (!parsed.success || (category && category.length > 80)) {
      return context.json({ success: false as const, message: "Invalid article filters.", responseCode: 400 }, 400);
    }
    const result = await dependencies.listPublishedPosts({ ...parsed.data, category: category || undefined });
    return context.json({ success: true as const, message: "Published articles loaded.", responseCode: 200, data: pageResult(result.items, result.total, parsed.data) });
  });
  router.get("/:slug", async (context) => {
    const post = await dependencies.getPublishedPost(context.req.param("slug"));
    if (!post) return context.json({ success: false as const, message: "Article not found.", responseCode: 404 }, 404);
    return context.json({ success: true as const, message: "Article loaded.", responseCode: 200, data: post });
  });
  return router;
}

export const publicBlogRouter = createPublicBlogRouter();
