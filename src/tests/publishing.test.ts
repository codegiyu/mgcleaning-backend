import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_REVALIDATION_ATTEMPTS,
  nextRetryDelayMs,
  revalidationForPostChange,
  sendRevalidation,
  signRevalidation,
} from "../cache/revalidation.js";
import { createAdminRouter, planPostPatch, type AdminRouterDependencies } from "../routes/v1/admin.js";

const now = new Date("2026-10-27T09:00:00.000Z");
const coverId = "7d1a0c52-4b5e-4f4a-9a4f-2f6f8f0b1c11";
const verifiedCover = { id: coverId, publicUrl: "https://media.example.test/cover.webp", status: "verified" };
const postId = "01c47f57-ea8c-4583-aad4-9ec537f4ff41";

function post(overrides: Partial<Parameters<typeof planPostPatch>[0]> = {}): Parameters<typeof planPostPatch>[0] {
  return {
    id: postId,
    title: "Preparing for a deep clean",
    slug: "preparing-for-a-deep-clean",
    excerpt: "A short checklist before the team arrives.",
    body: "Clear surfaces and note any fragile items before the visit.",
    category: "Home care",
    authorName: "M&G Cleaning Services",
    serviceSlug: "deep-cleaning",
    coverMediaId: coverId,
    coverImageUrl: verifiedCover.publicUrl,
    coverImageAlt: "A tidy living room",
    seoTitle: null,
    seoDescription: null,
    status: "draft",
    publishedAt: null,
    publishAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

const inOneDay = new Date(now.getTime() + 86_400_000);

describe("scheduling rules", () => {
  it("schedules a complete article for a future time", () => {
    const plan = planPostPatch(post(), { status: "scheduled", publishAt: inOneDay }, now, verifiedCover);
    expect(plan).toMatchObject({ kind: "apply", action: "post.schedule", update: { publishAt: inOneDay, publishedAt: null } });
  });

  it("requires a publish time", () => {
    expect(planPostPatch(post(), { status: "scheduled" }, now, verifiedCover)).toMatchObject({ kind: "invalid-schedule" });
  });

  it("refuses past and far-future times", () => {
    expect(planPostPatch(post(), { status: "scheduled", publishAt: new Date(now.getTime() - 1) }, now, verifiedCover)).toMatchObject({ kind: "invalid-schedule" });
    const tooFar = new Date(now.getTime() + 366 * 86_400_000);
    expect(planPostPatch(post(), { status: "scheduled", publishAt: tooFar }, now, verifiedCover)).toMatchObject({ kind: "invalid-schedule" });
  });

  it("applies the publish checks before scheduling", () => {
    const plan = planPostPatch(post({ coverImageAlt: null }), { status: "scheduled", publishAt: inOneDay }, now, verifiedCover);
    expect(plan).toEqual({ kind: "incomplete", missing: ["cover image alt text"] });
  });

  it("audits a reschedule even though the status is unchanged", () => {
    const plan = planPostPatch(post({ status: "scheduled", publishAt: inOneDay }), { publishAt: new Date(inOneDay.getTime() + 3_600_000) }, now, verifiedCover);
    expect(plan).toMatchObject({ kind: "apply", action: "post.schedule" });
  });

  it("clears the publish time when a scheduled article goes back to draft", () => {
    const plan = planPostPatch(post({ status: "scheduled", publishAt: inOneDay }), { status: "draft" }, now, verifiedCover);
    expect(plan).toMatchObject({ kind: "apply", update: { publishAt: null, publishedAt: null } });
  });

  it("publishes a scheduled article immediately when asked", () => {
    const plan = planPostPatch(post({ status: "scheduled", publishAt: inOneDay }), { status: "published" }, now, verifiedCover);
    expect(plan).toMatchObject({ kind: "apply", action: "post.publish", update: { publishAt: null, publishedAt: now } });
  });
});

describe("cache revalidation rules", () => {
  const draft = { status: "draft", slug: "deep-clean" };
  const live = { status: "published", slug: "deep-clean" };

  it("ignores changes that never touch the public site", () => {
    expect(revalidationForPostChange(draft, { ...draft, slug: "renamed" })).toBeNull();
    expect(revalidationForPostChange({ status: "scheduled", slug: "a" }, { status: "scheduled", slug: "a" })).toBeNull();
  });

  it("refreshes the list and article when an article goes live or is edited", () => {
    expect(revalidationForPostChange(draft, live)).toEqual({ tags: ["blog", "blog:deep-clean"], mode: "refresh" });
    expect(revalidationForPostChange(live, live)).toEqual({ tags: ["blog", "blog:deep-clean"], mode: "refresh" });
  });

  it("removes immediately when an article leaves the public site", () => {
    expect(revalidationForPostChange(live, draft)).toEqual({ tags: ["blog", "blog:deep-clean"], mode: "remove" });
    expect(revalidationForPostChange(live, { status: "archived", slug: "deep-clean" })?.mode).toBe("remove");
  });

  it("purges the old URL when a live slug changes", () => {
    expect(revalidationForPostChange(live, { status: "published", slug: "deep-clean-guide" })).toEqual({
      tags: ["blog", "blog:deep-clean", "blog:deep-clean-guide"],
      mode: "remove",
    });
  });
});

describe("revalidation delivery", () => {
  const target = { url: "https://www.example.test/api/revalidate", secret: "a-test-secret-that-is-at-least-32-chars" };

  it("signs the exact body with a timestamp", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    await sendRevalidation(target, { tags: ["blog"], mode: "refresh" }, fetchImpl, now.getTime());

    const [url, init] = fetchImpl.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const timestamp = headers["X-Revalidate-Timestamp"]!;
    const expected = createHmac("sha256", target.secret).update(`${timestamp}.${String(init?.body)}`).digest("hex");

    expect(url).toBe(target.url);
    expect(timestamp).toBe(String(Math.floor(now.getTime() / 1000)));
    expect(headers["X-Revalidate-Signature"]).toBe(expected);
    expect(signRevalidation(target.secret, timestamp, String(init?.body))).toBe(expected);
  });

  it("treats a non-2xx response as a failure to retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    await expect(sendRevalidation(target, { tags: ["blog"], mode: "refresh" }, fetchImpl)).rejects.toThrow("503");
  });

  it("backs off exponentially and caps the delay", () => {
    expect(nextRetryDelayMs(1)).toBe(10_000);
    expect(nextRetryDelayMs(3)).toBe(40_000);
    expect(nextRetryDelayMs(MAX_REVALIDATION_ATTEMPTS)).toBe(15 * 60_000);
  });
});

describe("schedule route contract", () => {
  const token = "a-session-token-used-only-in-this-test";
  const headers = { Cookie: `mg_admin_session=${token}`, Origin: "http://localhost:3000", "Content-Type": "application/json" };

  function router(updatePost: AdminRouterDependencies["updatePost"]) {
    return createAdminRouter({
      async resolveSession(value: string) { return value === token ? { id: postId, email: "admin@example.test", sessionId: postId, role: "owner" as const, mustChangePassword: false } : null; },
      updatePost,
    } as unknown as AdminRouterDependencies); // Only session and update are exercised.
  }

  it("requires an explicit UTC offset on the publish time", async () => {
    const updatePost = vi.fn<AdminRouterDependencies["updatePost"]>();
    const response = await router(updatePost).request(`/blog/posts/${postId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "scheduled", publishAt: "2026-10-28 09:00" }),
    });
    expect(response.status).toBe(400);
    expect(updatePost).not.toHaveBeenCalled();
  });

  it("passes an offset publish time through as a Date and reports schedule errors", async () => {
    const updatePost = vi.fn<AdminRouterDependencies["updatePost"]>(async () => ({ kind: "invalid-schedule", message: "Choose a publish time in the future." }));
    const response = await router(updatePost).request(`/blog/posts/${postId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "scheduled", publishAt: "2026-10-28T10:00:00+01:00" }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe("Choose a publish time in the future.");
    expect(updatePost.mock.calls[0]?.[1].publishAt).toEqual(new Date("2026-10-28T09:00:00.000Z"));
  });
});
