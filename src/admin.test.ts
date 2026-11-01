import { describe, expect, it, vi } from "vitest";
import {
  createAdminRouter,
  createPublicBlogRouter,
  planPostPatch,
  type AdminRouterDependencies,
} from "./routes/v1/admin.js";

const actor = { id: "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5", email: "admin@example.test", role: "owner" as const, mustChangePassword: false };
const sessionActor = { ...actor, sessionId: "c0ffee00-1d2e-4f3a-8b9c-0d1e2f3a4b5c" };
const token = "a-session-token-used-only-in-this-test";
const postId = "01c47f57-ea8c-4583-aad4-9ec537f4ff41";
const validPostPayload = {
  title: "A sample upholstery care article",
  slug: "sample-upholstery-care-article",
  excerpt: "An example article summary for the local demo site.",
  body: "Sample article content for a local demo.\n\nThis paragraph is only placeholder material.",
  category: "Upholstery care",
  authorName: "M&G Cleaning Services",
  serviceSlug: "upholstery-cleaning",
};

type CreateInput = Parameters<AdminRouterDependencies["createPost"]>[0];

function postFromInput(input: CreateInput) {
  return {
    id: postId,
    ...input,
    coverMediaId: input.coverMediaId ?? null,
    coverImageUrl: null,
    coverImageAlt: input.coverImageAlt ?? null,
    seoTitle: input.seoTitle ?? null,
    seoDescription: input.seoDescription ?? null,
    status: "draft",
    publishedAt: null,
    publishAt: null,
    createdAt: new Date("2026-09-14T12:00:00.000Z"),
    updatedAt: new Date("2026-09-14T12:00:00.000Z"),
  };
}

function admin(dependencies: Partial<AdminRouterDependencies> = {}) {
  const defaults: AdminRouterDependencies = {
    async login() { return { kind: "success", actor, token }; },
    async resolveSession(value) { return value === token ? sessionActor : null; },
    async revokeSession() {},
    async getOverview() { return { inquiryCounts: { total: 0, new: 0 }, postCounts: { draft: 0, published: 0 } }; },
    async listInquiries() { return { items: [], total: 0 }; },
    async getInquiry() { return null; },
    async getInquiryNotifications() { return []; },
    async updateInquiry() { return null; },
    async deleteInquiry() { return true; },
    async listPosts() { return { items: [], total: 0 }; },
    async getPost() { return null; },
    async createPost(input) { return { kind: "created", post: postFromInput(input) }; },
    async updatePost() { return { kind: "not-found" }; },
    async listPublishedPosts() { return { items: [], total: 0 }; },
    async getPublishedPost() { return null; },
  };
  return createAdminRouter({ ...defaults, ...dependencies });
}

const authHeaders = {
  Cookie: `mg_admin_session=${token}`,
  Origin: "http://localhost:3000",
};

describe("admin authentication", () => {
  it("denies private data requests without a valid session", async () => {
    const listInquiries = vi.fn(async () => ({ items: [], total: 0 }));
    const router = admin({ listInquiries });
    const response = await router.request("/inquiries");

    expect(response.status).toBe(401);
    expect(listInquiries).not.toHaveBeenCalled();
  });

  it("sets an HttpOnly cookie and resolves its opaque session", async () => {
    const router = admin();
    const login = await router.request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000" },
      body: JSON.stringify({ email: actor.email, password: "not-echoed-in-responses" }),
    });
    const cookie = login.headers.get("set-cookie");

    expect(login.status).toBe(200);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("mg_admin_session=");

    const session = await router.request("/auth/session", { headers: { Cookie: `mg_admin_session=${token}` } });
    expect(session.status).toBe(200);
    // The session ID is server-side state and must not reach the browser.
    expect((await session.json()).data).toEqual({ authenticated: true, user: actor });
  });

  it("reports a missing session without treating a signed-out visitor as an API error", async () => {
    const response = await admin().request("/auth/session");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ authenticated: false, user: null });
  });

  it("revokes the session on logout", async () => {
    const revokeSession = vi.fn(async () => {});
    const router = admin({ revokeSession });
    const response = await router.request("/auth/logout", {
      method: "POST",
      headers: authHeaders,
    });

    expect(response.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith(token, expect.any(Object));
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("rejects cross-origin login attempts", async () => {
    const login = vi.fn(async () => ({ kind: "success" as const, actor, token }));
    const response = await admin({ login }).request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.example" },
      body: JSON.stringify({ email: actor.email, password: "whatever" }),
    });

    expect(response.status).toBe(403);
    expect(login).not.toHaveBeenCalled();
  });
});

describe("admin blog editor", () => {
  it("creates only a validated draft by default", async () => {
    const createPost = vi.fn(async (input: CreateInput) => ({ kind: "created" as const, post: postFromInput(input) }));
    const response = await admin({ createPost }).request("/blog/posts", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(validPostPayload),
    });

    expect(response.status).toBe(201);
    expect((await response.json()).data.status).toBe("draft");
    expect(createPost).toHaveBeenCalledOnce();
  });

  it("keeps draft posts out of unauthenticated public article reads", async () => {
    const publicRouter = createPublicBlogRouter({
      async listPublishedPosts() { return { items: [], total: 0 }; },
      async getPublishedPost() { return null; },
    });
    const response = await publicRouter.request("/draft-only-article");
    expect(response.status).toBe(404);
  });

  it("reports missing editorial evidence returned by the publish gate", async () => {
    const updatePost = vi.fn(async () => ({ kind: "incomplete" as const, missing: ["cover image", "cover image alt text"] }));
    const response = await admin({ updatePost }).request(`/blog/posts/${postId}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "published" }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("cover image");
    expect(updatePost).toHaveBeenCalledOnce();
  });
});

const coverId = "7d1a0c52-4b5e-4f4a-9a4f-2f6f8f0b1c11";
const verifiedCover = { id: coverId, publicUrl: "https://media.example.test/cover.webp", status: "verified" };

function storedPost(overrides: Partial<Parameters<typeof planPostPatch>[0]> = {}): Parameters<typeof planPostPatch>[0] {
  return {
    id: postId,
    ...validPostPayload,
    coverMediaId: coverId,
    coverImageUrl: "https://media.example.test/cover.webp",
    coverImageAlt: "A freshly cleaned sofa",
    seoTitle: null,
    seoDescription: null,
    status: "draft",
    publishedAt: null,
    publishAt: null,
    createdAt: new Date("2026-09-14T12:00:00.000Z"),
    updatedAt: new Date("2026-09-14T12:00:00.000Z"),
    ...overrides,
  };
}

/** Mirrors how Drizzle wraps a postgres-js unique violation. */
function uniqueViolation(constraint: string) {
  return Object.assign(new Error("Failed query"), {
    cause: Object.assign(new Error("duplicate key value"), { code: "23505", constraint_name: constraint }),
  });
}

describe("post patch planning", () => {
  const now = new Date("2026-10-26T12:00:00.000Z");

  it("refuses to publish without a cover", () => {
    const plan = planPostPatch(storedPost({ coverMediaId: null, coverImageUrl: null }), { status: "published" }, now, null);
    expect(plan).toEqual({ kind: "incomplete", missing: ["cover image"] });
  });

  it("does not accept a legacy cover URL without a verified upload", () => {
    const plan = planPostPatch(storedPost({ coverMediaId: null }), { status: "published" }, now, null);
    expect(plan).toEqual({ kind: "incomplete", missing: ["cover image"] });
  });

  it("refuses to clear the cover alt text of a live article", () => {
    const plan = planPostPatch(storedPost({ status: "published" }), { coverImageAlt: "" }, now, verifiedCover);
    expect(plan).toEqual({ kind: "incomplete", missing: ["cover image alt text"] });
  });

  it("refuses to attach an upload that is not verified", () => {
    const pendingId = "9b2f5d1e-0c3a-4e7b-8f6d-1a2b3c4d5e6f";
    const plan = planPostPatch(
      storedPost({ coverMediaId: null, coverImageUrl: null }),
      { coverMediaId: pendingId },
      now,
      { id: pendingId, publicUrl: "https://media.example.test/pending.webp", status: "pending" },
    );
    expect(plan).toEqual({ kind: "invalid-cover" });
  });

  it("derives the cover URL from the verified upload", () => {
    const plan = planPostPatch(storedPost({ coverMediaId: null, coverImageUrl: null }), { coverMediaId: coverId }, now, verifiedCover);
    expect(plan).toMatchObject({ kind: "apply", update: { coverMediaId: coverId, coverImageUrl: verifiedCover.publicUrl } });
  });

  it("clears the cover URL when the cover is removed from a draft", () => {
    const plan = planPostPatch(storedPost(), { coverMediaId: null }, now, null);
    expect(plan).toMatchObject({ kind: "apply", update: { coverMediaId: null, coverImageUrl: null } });
  });

  it("stamps the publish time and audits a first publish", () => {
    const plan = planPostPatch(storedPost(), { status: "published" }, now, verifiedCover);
    expect(plan).toMatchObject({ kind: "apply", action: "post.publish", statusFrom: "draft", statusTo: "published" });
    expect(plan.kind === "apply" && plan.update.publishedAt).toEqual(now);
  });

  it("keeps the original publish time when a live article is edited", () => {
    const plan = planPostPatch(
      storedPost({ status: "published", publishedAt: new Date("2026-10-01T09:00:00.000Z") }),
      { title: "A clearer title" },
      now,
      verifiedCover,
    );
    expect(plan).toMatchObject({ kind: "apply", action: "post.update" });
    expect(plan.kind === "apply" && "publishedAt" in plan.update).toBe(false);
  });

  it("clears the publish time when an article is unpublished", () => {
    const plan = planPostPatch(storedPost({ status: "published" }), { status: "draft" }, now, verifiedCover);
    expect(plan).toMatchObject({ kind: "apply", action: "post.unpublish" });
    expect(plan.kind === "apply" && plan.update.publishedAt).toBeNull();
  });
});

describe("admin blog error mapping", () => {
  it("returns 409 for a slug unique violation", async () => {
    const response = await admin({
      async createPost() { throw uniqueViolation("blog_posts_slug_unique"); },
    }).request("/blog/posts", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(validPostPayload),
    });
    expect(response.status).toBe(409);
  });

  it("does not disguise other failures as slug conflicts", async () => {
    const router = admin({
      async updatePost() { throw new Error("connection terminated"); },
    });
    router.onError((_error, context) => context.json({ success: false, message: "server error", responseCode: 500 }, 500));
    const response = await router.request(`/blog/posts/${postId}`, {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title: "A sample upholstery care article" }),
    });
    expect(response.status).toBe(500);
  });

  it("does not treat other unique constraints as slug conflicts", async () => {
    const router = admin({
      async createPost() { throw uniqueViolation("some_other_unique"); },
    });
    router.onError((_error, context) => context.json({ success: false, message: "server error", responseCode: 500 }, 500));
    const response = await router.request("/blog/posts", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify(validPostPayload),
    });
    expect(response.status).toBe(500);
  });
});

describe("admin audit context", () => {
  it("attributes inquiry updates to the signed-in actor", async () => {
    const updateInquiry = vi.fn(async () => null);
    await admin({ updateInquiry }).request("/inquiries/5a3c2a3e-8a0b-4d8e-9a43-1c7c5b5f9a10", {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "contacted" }),
    });
    expect(updateInquiry).toHaveBeenCalledWith(
      "5a3c2a3e-8a0b-4d8e-9a43-1c7c5b5f9a10",
      { status: "contacted" },
      { actorId: actor.id, ipHash: null, requestId: null },
    );
  });

  it("attributes logout to the session owner", async () => {
    const revokeSession = vi.fn(async () => {});
    await admin({ revokeSession }).request("/auth/logout", { method: "POST", headers: authHeaders });
    expect(revokeSession).toHaveBeenCalledWith(token, expect.objectContaining({ actorId: actor.id }));
  });
});

describe("admin blog cover contract", () => {
  it("rejects a client-supplied cover URL", async () => {
    const createPost = vi.fn(async (input: CreateInput) => ({ kind: "created" as const, post: postFromInput(input) }));
    const response = await admin({ createPost }).request("/blog/posts", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ ...validPostPayload, coverImageUrl: "https://attacker.example/tracker.png" }),
    });
    expect(response.status).toBe(400);
    expect(createPost).not.toHaveBeenCalled();
  });

  it("reports an unusable cover upload", async () => {
    const response = await admin({ async createPost() { return { kind: "invalid-cover" }; } }).request("/blog/posts", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ ...validPostPayload, coverMediaId: coverId }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("cover image");
  });
});
