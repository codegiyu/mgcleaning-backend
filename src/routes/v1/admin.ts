import { createHash, randomBytes } from "node:crypto";
import { and, count, desc, eq, gt, ilike, or } from "drizzle-orm";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { env } from "../../env.js";
import { hashPassword, verifyPassword } from "../../auth/password.js";
import { allowLoginAttempt, clearLoginAttempts } from "../../auth/login-rate-limit.js";
import { getDb } from "../../db/client.js";
import { adminSessions } from "../../db/schema/adminSessions.js";
import { adminUsers } from "../../db/schema/adminUsers.js";
import { blogPosts } from "../../db/schema/blogPosts.js";
import { contactInquiries } from "../../db/schema/contactInquiries.js";
import { emailOutbox } from "../../db/schema/emailOutbox.js";

const SESSION_COOKIE = "mg_admin_session";
const SESSION_SECONDS = 60 * 60 * 12;
const DUMMY_HASH = `scrypt$${"0".repeat(32)}$${"0".repeat(128)}`;

export const inquiryStatuses = ["new", "contacted", "quoted", "booked", "closed"] as const;
export type InquiryStatus = (typeof inquiryStatuses)[number];
export const postStatuses = ["draft", "published", "archived"] as const;
export type PostStatus = (typeof postStatuses)[number];

export type AdminActor = { id: string; email: string };
type InquiryRecord = typeof contactInquiries.$inferSelect;
type BlogPostRecord = typeof blogPosts.$inferSelect;
type LoginResult =
  | { kind: "success"; actor: AdminActor; token: string }
  | { kind: "invalid" }
  | { kind: "rate-limited" };
type PageQuery = { page: number; pageSize: number; query?: string };

export type AdminRouterDependencies = {
  login: (email: string, password: string) => Promise<LoginResult>;
  resolveSession: (token: string) => Promise<AdminActor | null>;
  revokeSession: (token: string) => Promise<void>;
  getOverview: () => Promise<{
    inquiryCounts: { total: number; new: number };
    postCounts: { draft: number; published: number };
    emailOutboxCounts?: { pending: number; failed: number; deadLetter: number };
  }>;
  listInquiries: (query: PageQuery & { status: InquiryStatus | "all" }) => Promise<{
    items: InquiryRecord[];
    total: number;
  }>;
  getInquiry: (id: string) => Promise<InquiryRecord | null>;
  updateInquiry: (
    id: string,
    patch: { status?: InquiryStatus; internalNote?: string | null },
  ) => Promise<InquiryRecord | null>;
  listPosts: (query: PageQuery & { status: PostStatus | "all" }) => Promise<{
    items: BlogPostRecord[];
    total: number;
  }>;
  getPost: (id: string) => Promise<BlogPostRecord | null>;
  createPost: (input: BlogPostInput) => Promise<BlogPostRecord>;
  updatePost: (id: string, patch: BlogPostPatch) => Promise<BlogPostRecord | null>;
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
    authorName: z.string().trim().min(2).max(120).default("M&G Cleaning Service"),
    serviceSlug: z.string().trim().min(2).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    coverImageUrl: z.preprocess(
      (value) => (value === "" ? undefined : value),
      z.string().url().refine((value) => /^https?:\/\//i.test(value)).optional(),
    ),
    coverImageAlt: z.string().trim().max(250).optional(),
    seoTitle: z.string().trim().max(180).optional(),
    seoDescription: z.string().trim().max(320).optional(),
  })
  .strict();

const blogPostPatchSchema = blogPostInputSchema
  .partial()
  .extend({ status: z.enum(postStatuses).optional() })
  .strict()
  .refine((value) => Object.keys(value).length > 0);

type BlogPostInput = z.infer<typeof blogPostInputSchema>;
type BlogPostPatch = z.infer<typeof blogPostPatchSchema>;

function publishValidation(post: { authorName?: string | null; serviceSlug?: string | null; coverImageUrl?: string | null; coverImageAlt?: string | null }) {
  const missing: string[] = [];
  if (!post.authorName?.trim()) missing.push("author");
  if (!post.serviceSlug?.trim()) missing.push("related service");
  if (!post.coverImageUrl?.trim()) missing.push("cover image");
  if (!post.coverImageAlt?.trim()) missing.push("cover image alt text");
  return missing;
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
const uuidSchema = z.string().uuid();
const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
  query: z.string().trim().max(120).optional(),
});

function digestToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, "\\$&");
}

function pageResult<T>(items: T[], total: number, query: PageQuery) {
  return { items, total, page: query.page, pageSize: query.pageSize };
}

function parsePageQuery(context: Context) {
  return pageSchema.safeParse({
    page: context.req.query("page"),
    pageSize: context.req.query("pageSize"),
    query: context.req.query("query"),
  });
}

async function createDatabaseSession(email: string, password: string): Promise<LoginResult> {
  const permitted = await allowLoginAttempt(email);
  if (!permitted) return { kind: "rate-limited" };

  const normalizedEmail = email.toLowerCase();
  const [user] = await getDb()
    .select()
    .from(adminUsers)
    .where(eq(adminUsers.email, normalizedEmail))
    .limit(1);
  const passwordIsValid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
  if (!user || !passwordIsValid) return { kind: "invalid" };
  await clearLoginAttempts(email);

  const token = randomBytes(32).toString("base64url");
  await getDb().insert(adminSessions).values({
    userId: user.id,
    tokenHash: digestToken(token),
    expiresAt: new Date(Date.now() + SESSION_SECONDS * 1_000),
  });

  return { kind: "success", actor: { id: user.id, email: user.email }, token };
}

async function resolveDatabaseSession(token: string): Promise<AdminActor | null> {
  const [session] = await getDb()
    .select({ id: adminUsers.id, email: adminUsers.email })
    .from(adminSessions)
    .innerJoin(adminUsers, eq(adminUsers.id, adminSessions.userId))
    .where(
      and(
        eq(adminSessions.tokenHash, digestToken(token)),
        gt(adminSessions.expiresAt, new Date()),
      ),
    )
    .limit(1);
  return session ?? null;
}

async function revokeDatabaseSession(token: string) {
  await getDb().delete(adminSessions).where(eq(adminSessions.tokenHash, digestToken(token)));
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
      };
    },
    async listInquiries(query) {
      const conditions = [];
      if (query.status !== "all") conditions.push(eq(contactInquiries.status, query.status));
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
    async getInquiry(id) {
      const [item] = await getDb()
        .select()
        .from(contactInquiries)
        .where(eq(contactInquiries.id, id))
        .limit(1);
      return item ?? null;
    },
    async updateInquiry(id, patch) {
      const [item] = await getDb()
        .update(contactInquiries)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(contactInquiries.id, id))
        .returning();
      return item ?? null;
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
    async createPost(input) {
      const [post] = await getDb()
        .insert(blogPosts)
        .values({ ...input, serviceSlug: input.serviceSlug, authorName: input.authorName, coverImageUrl: input.coverImageUrl ?? null, coverImageAlt: input.coverImageAlt ?? null, seoTitle: input.seoTitle ?? null, seoDescription: input.seoDescription ?? null })
        .returning();
      if (!post) throw new Error("Blog post insert returned no row.");
      return post;
    },
    async updatePost(id, patch) {
      const existing = await this.getPost(id);
      if (!existing) return null;
      const update: Partial<typeof blogPosts.$inferInsert> = { ...patch, updatedAt: new Date() };
      if (patch.status === "published" && existing.status !== "published") update.publishedAt = new Date();
      if (patch.status === "draft") update.publishedAt = null;
      const [post] = await getDb().update(blogPosts).set(update).where(eq(blogPosts.id, id)).returning();
      return post ?? null;
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

function trustedOrigin(context: Context) {
  const origin = context.req.header("origin");
  return origin === env.FRONTEND_ORIGIN;
}

export function createAdminRouter(dependencies = buildProductionDependencies()) {
  const router = new Hono<{ Variables: { admin: AdminActor } }>();

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
      const result = await dependencies.login(parsed.data.email, parsed.data.password);
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
    } catch {
      return context.json({ success: false as const, message: "Sign-in is temporarily unavailable.", responseCode: 503 }, 503);
    }
  });

  router.get("/auth/session", async (context) => {
    const token = getCookie(context, SESSION_COOKIE);
    const actor = token ? await dependencies.resolveSession(token) : null;
    const data = actor ? { authenticated: true as const, user: actor } : { authenticated: false as const, user: null };
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
    if (token) await dependencies.revokeSession(token);
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
    if (!parsed.success || !(status === "all" || inquiryStatuses.includes(status as InquiryStatus))) {
      return context.json({ success: false as const, message: "Invalid inquiry filters.", responseCode: 400 }, 400);
    }
    const result = await dependencies.listInquiries({ ...parsed.data, status: status as InquiryStatus | "all" });
    return context.json({ success: true as const, message: "Inquiries loaded.", responseCode: 200, data: pageResult(result.items, result.total, parsed.data) });
  });

  router.get("/inquiries/:id", async (context) => {
    const id = context.req.param("id");
    if (!uuidSchema.safeParse(id).success) {
      return context.json({ success: false as const, message: "Inquiry not found.", responseCode: 404 }, 404);
    }
    const item = await dependencies.getInquiry(id);
    if (!item) return context.json({ success: false as const, message: "Inquiry not found.", responseCode: 404 }, 404);
    return context.json({ success: true as const, message: "Inquiry loaded.", responseCode: 200, data: item });
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
    const item = await dependencies.updateInquiry(id, parsed.data);
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
      const post = await dependencies.createPost(parsed.data);
      return context.json({ success: true as const, message: "Draft created.", responseCode: 201, data: post }, 201);
    } catch {
      return context.json({ success: false as const, message: "That article URL is already in use.", responseCode: 409 }, 409);
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
    try {
      if (parsed.data.status === "published") {
        const missing = publishValidation({ ...await dependencies.getPost(id), ...parsed.data });
        if (missing.length) {
          return context.json({ success: false as const, message: `Add ${missing.join(", ")} before publishing this article.`, responseCode: 400 }, 400);
        }
      }
      const post = await dependencies.updatePost(id, parsed.data);
      if (!post) return context.json({ success: false as const, message: "Blog post not found.", responseCode: 404 }, 404);
      return context.json({ success: true as const, message: "Blog post updated.", responseCode: 200, data: post });
    } catch {
      return context.json({ success: false as const, message: "That article URL is already in use.", responseCode: 409 }, 409);
    }
  });

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
