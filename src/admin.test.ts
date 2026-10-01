import { describe, expect, it, vi } from "vitest";
import {
  createAdminRouter,
  createPublicBlogRouter,
  type AdminRouterDependencies,
} from "./routes/v1/admin.js";

const actor = { id: "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5", email: "admin@example.test" };
const token = "a-session-token-used-only-in-this-test";
const validPostPayload = {
  title: "A sample upholstery care article",
  slug: "sample-upholstery-care-article",
  excerpt: "An example article summary for the local demo site.",
  body: "Sample article content for a local demo.\n\nThis paragraph is only placeholder material.",
  category: "Upholstery care",
  authorName: "M&G Cleaning Services",
  serviceSlug: "upholstery-cleaning",
};

function admin(dependencies: Partial<AdminRouterDependencies> = {}) {
  const defaults: AdminRouterDependencies = {
    async login() { return { kind: "success", actor, token }; },
    async resolveSession(value) { return value === token ? actor : null; },
    async revokeSession() {},
    async getOverview() { return { inquiryCounts: { total: 0, new: 0 }, postCounts: { draft: 0, published: 0 } }; },
    async listInquiries() { return { items: [], total: 0 }; },
    async getInquiry() { return null; },
    async updateInquiry() { return null; },
    async listPosts() { return { items: [], total: 0 }; },
    async getPost() { return null; },
    async createPost(input) {
      return {
        id: "01c47f57-ea8c-4583-aad4-9ec537f4ff41",
        ...input,
        coverImageUrl: input.coverImageUrl ?? null,
        coverImageAlt: input.coverImageAlt ?? null,
        seoTitle: input.seoTitle ?? null,
        seoDescription: input.seoDescription ?? null,
        status: "draft",
        publishedAt: null,
        createdAt: new Date("2026-09-14T12:00:00.000Z"),
        updatedAt: new Date("2026-09-14T12:00:00.000Z"),
      };
    },
    async updatePost() { return null; },
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
    expect(revokeSession).toHaveBeenCalledWith(token);
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
    const createPost = vi.fn(async (input: Parameters<AdminRouterDependencies["createPost"]>[0]) => {
      return {
        id: "01c47f57-ea8c-4583-aad4-9ec537f4ff41",
        ...input,
        coverImageUrl: null,
        coverImageAlt: null,
        seoTitle: null,
        seoDescription: null,
        status: "draft",
        publishedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
    });
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

  it("requires editorial evidence before publishing an article", async () => {
    const updatePost = vi.fn(async () => null);
    const response = await admin({
      async getPost() {
        return {
          id: "01c47f57-ea8c-4583-aad4-9ec537f4ff41",
          ...validPostPayload,
          coverImageUrl: null,
          coverImageAlt: null,
          seoTitle: null,
          seoDescription: null,
          status: "draft" as const,
          publishedAt: null,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      updatePost,
    }).request("/blog/posts/01c47f57-ea8c-4583-aad4-9ec537f4ff41", {
      method: "PATCH",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ status: "published" }),
    });

    expect(response.status).toBe(400);
    expect((await response.json()).message).toContain("cover image");
    expect(updatePost).not.toHaveBeenCalled();
  });
});
