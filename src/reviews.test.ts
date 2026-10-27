import { describe, expect, it, vi } from "vitest";
import { revalidationForReviewChange } from "./cache/revalidation.js";
import type { Review } from "./db/schema/reviews.js";
import { planReviewWrite, reviewInputSchema, reviewPatchSchema, startOfWatYear, toPublicReview, watToday } from "./reviews/policy.js";
import { createAdminRouter, type AdminRouterDependencies } from "./routes/v1/admin.js";
import { createPublicReviewsRouter, createReviewsAdminRouter, type ReviewsRouterDependencies } from "./routes/v1/reviews.js";

const token = "a-session-token-used-only-in-this-test";
const actor = { id: "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5", email: "admin@example.test", sessionId: "c0ffee00-1d2e-4f3a-8b9c-0d1e2f3a4b5c" };
const headers = { Cookie: `mg_admin_session=${token}`, Origin: "http://localhost:3000", "Content-Type": "application/json" };
const reviewId = "7d5f0a8e-2b9c-4c1d-9e8f-1a2b3c4d5e6f";
const now = new Date("2026-10-27T09:00:00.000Z");

const validInput = {
  displayName: "Amaka O.",
  context: "Homeowner, Wuse 2",
  quote: "The team was on time and the sofa looks brand new again.",
  rating: 5,
  serviceSlug: "upholstery-cleaning",
  source: "whatsapp",
  receivedOn: "2026-10-20",
};

function storedReview(overrides: Partial<Review> = {}): Review {
  return {
    id: reviewId,
    displayName: "Amaka O.",
    context: "Homeowner, Wuse 2",
    quote: "The team was on time and the sofa looks brand new again.",
    rating: 5,
    serviceSlug: "upholstery-cleaning",
    source: "whatsapp",
    receivedOn: "2026-10-20",
    featured: false,
    status: "published",
    consentConfirmedAt: now,
    consentConfirmedBy: actor.id,
    publishedAt: now,
    createdBy: actor.id,
    updatedBy: actor.id,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function app(reviews: Partial<ReviewsRouterDependencies> = {}) {
  const dependencies: ReviewsRouterDependencies = {
    async listReviews() { return { items: [storedReview()], total: 1 }; },
    async countReviews() { return { published: 1, publishedThisYear: 1, draft: 0 }; },
    async getReview(id) { return id === reviewId ? storedReview() : null; },
    async createReview() { return { kind: "created", review: storedReview({ status: "draft" }) }; },
    async updateReview() { return { kind: "updated", review: storedReview() }; },
    async deleteReview() { return { kind: "deleted" }; },
    ...reviews,
  };
  const adminDependencies = {
    async resolveSession(value: string) { return value === token ? actor : null; },
  } as unknown as AdminRouterDependencies; // Only the review routes are exercised.
  return createAdminRouter(adminDependencies, undefined, undefined, undefined, createReviewsAdminRouter(dependencies));
}

describe("review validation", () => {
  it("accepts a complete review and normalises the optional fields", () => {
    const parsed = reviewInputSchema.parse({ ...validInput, context: "", receivedOn: "" });
    expect(parsed.context).toBeNull();
    expect(parsed.receivedOn).toBeNull();
  });

  it.each([
    ["a name with markup", { displayName: "<script>alert(1)</script>" }],
    ["a name with a link", { displayName: "Visit www.spam.example" }],
    ["a two-line name", { displayName: "Amaka\nO." }],
    ["a short quote", { quote: "Great!" }],
    ["a long quote", { quote: "x".repeat(601) }],
    ["a quote with control characters", { quote: "Lovely work from the team\u0007 every single time." }],
    ["a rating of 6", { rating: 6 }],
    ["an unknown source", { source: "billboard" }],
    ["an impossible date", { receivedOn: "2026-02-30" }],
    ["a malformed service", { serviceSlug: "Upholstery Cleaning" }],
    ["an unknown field", { approvedBy: "someone" }],
  ])("rejects %s", (_label, change) => {
    expect(reviewInputSchema.safeParse({ ...validInput, ...change }).success).toBe(false);
  });

  it("keeps line breaks but collapses runs of blank lines in the quote", () => {
    const parsed = reviewInputSchema.parse({ ...validInput, quote: "First visit was excellent.\r\n\r\n\r\n\r\nSecond was even better." });
    expect(parsed.quote).toBe("First visit was excellent.\n\nSecond was even better.");
  });

  it("requires the version a patch was edited from, and at least one change", () => {
    expect(reviewPatchSchema.safeParse({ featured: true }).success).toBe(false);
    expect(reviewPatchSchema.safeParse({ expectedUpdatedAt: now.toISOString() }).success).toBe(false);
    expect(reviewPatchSchema.safeParse({ featured: true, expectedUpdatedAt: now.toISOString() }).success).toBe(true);
  });
});

describe("review write rules", () => {
  const input = reviewInputSchema.parse(validInput);

  it("refuses to publish without recorded consent", () => {
    expect(planReviewWrite(null, { ...input, status: "published" }, { now, actorId: actor.id }).kind).toBe("consent-required");
  });

  it("records who confirmed consent and when the review went live", () => {
    const plan = planReviewWrite(null, { ...input, status: "published", consentConfirmed: true }, { now, actorId: actor.id });
    expect(plan).toMatchObject({ kind: "apply", action: "review.create", statusTo: "published" });
    if (plan.kind !== "apply") return;
    expect(plan.values).toMatchObject({ consentConfirmedAt: now, consentConfirmedBy: actor.id, publishedAt: now, createdBy: actor.id, createdAt: now, updatedAt: now });
    expect(plan.values).not.toHaveProperty("consentConfirmed");
  });

  it("names changed fields without copying their values", () => {
    const plan = planReviewWrite(null, input, { now, actorId: actor.id });
    expect(plan.kind === "apply" && plan.fields).toEqual(["context", "displayName", "quote", "rating", "receivedOn", "serviceSlug", "source"]);
  });

  it("refuses a patch based on an older version of the review", () => {
    const existing = storedReview();
    const stale = new Date(now.getTime() - 1000).toISOString();
    expect(planReviewWrite(existing, { featured: true }, { now, actorId: actor.id, expectedUpdatedAt: stale }).kind).toBe("conflict");
    expect(planReviewWrite(existing, { featured: true }, { now, actorId: actor.id, expectedUpdatedAt: now.toISOString() }).kind).toBe("apply");
  });

  it("does not let consent be withdrawn while the review is live", () => {
    const options = { now, actorId: actor.id, expectedUpdatedAt: now.toISOString() };
    expect(planReviewWrite(storedReview(), { consentConfirmed: false }, options).kind).toBe("consent-required");
    const plan = planReviewWrite(storedReview(), { consentConfirmed: false, status: "draft" }, options);
    expect(plan).toMatchObject({ kind: "apply", action: "review.unpublish", statusFrom: "published", statusTo: "draft" });
    expect(plan.kind === "apply" && plan.values).toMatchObject({ consentConfirmedAt: null, consentConfirmedBy: null, publishedAt: null });
  });

  it("keeps the original publish time when a live review is edited", () => {
    const plan = planReviewWrite(storedReview(), { quote: "Updated: the sofa still looks brand new weeks later." }, { now: new Date(now.getTime() + 60_000), actorId: actor.id, expectedUpdatedAt: now.toISOString() });
    expect(plan).toMatchObject({ kind: "apply", action: "review.update" });
    expect(plan.kind === "apply" && plan.values).not.toHaveProperty("publishedAt");
  });

  it("refuses a received date after today in WAT", () => {
    const lateEvening = new Date("2026-10-27T23:30:00.000Z"); // 00:30 on 28 October in WAT
    expect(watToday(lateEvening)).toBe("2026-10-28");
    expect(planReviewWrite(null, { ...input, receivedOn: "2026-10-28" }, { now: lateEvening, actorId: actor.id }).kind).toBe("apply");
    expect(planReviewWrite(null, { ...input, receivedOn: "2026-10-29" }, { now: lateEvening, actorId: actor.id }).kind).toBe("future-date");
  });

  it("counts the year from midnight WAT on 1 January", () => {
    expect(startOfWatYear(now).toISOString()).toBe("2025-12-31T23:00:00.000Z");
  });
});

describe("review cache purges", () => {
  it.each([
    ["draft edits", { status: "draft" }, { status: "draft" }, null],
    ["publishing", { status: "draft" }, { status: "published" }, "refresh"],
    ["editing a live review", { status: "published" }, { status: "published" }, "refresh"],
    ["unpublishing", { status: "published" }, { status: "draft" }, "remove"],
    ["deleting a live review", { status: "published" }, null, "remove"],
    ["deleting a draft", { status: "draft" }, null, null],
  ] as const)("%s", (_label, before, after, mode) => {
    const change = revalidationForReviewChange(before, after);
    expect(change?.mode ?? null).toBe(mode);
    if (change) expect(change.tags).toEqual(["reviews"]);
  });
});

describe("admin review routes", () => {
  it("requires a session", async () => {
    expect((await app().request("/reviews", { headers: { ...headers, Cookie: "" } })).status).toBe(401);
  });

  it("returns the list with the dashboard counts", async () => {
    const body = await (await app().request("/reviews?status=published", { headers })).json();
    expect(body.data).toMatchObject({ total: 1, counts: { published: 1, publishedThisYear: 1, draft: 0 } });
  });

  it("rejects an unknown status filter", async () => {
    expect((await app().request("/reviews?status=archived", { headers })).status).toBe(400);
  });

  it("refuses writes from other origins before touching the database", async () => {
    const createReview = vi.fn<ReviewsRouterDependencies["createReview"]>();
    const response = await app({ createReview }).request("/reviews", { method: "POST", headers: { ...headers, Origin: "https://attacker.example" }, body: JSON.stringify(validInput) });
    expect(response.status).toBe(403);
    expect(createReview).not.toHaveBeenCalled();
  });

  it("creates a review attributed to the signed-in editor", async () => {
    const createReview = vi.fn<ReviewsRouterDependencies["createReview"]>(async () => ({ kind: "created", review: storedReview({ status: "draft" }) }));
    const response = await app({ createReview }).request("/reviews", { method: "POST", headers, body: JSON.stringify(validInput) });
    expect(response.status).toBe(201);
    expect(createReview).toHaveBeenCalledWith(expect.objectContaining({ displayName: "Amaka O." }), expect.objectContaining({ actorId: actor.id }));
  });

  it("rejects invalid review details", async () => {
    const response = await app().request("/reviews", { method: "POST", headers, body: JSON.stringify({ ...validInput, quote: "Short" }) });
    expect(response.status).toBe(400);
  });

  it.each([
    ["consent-required", 422],
    ["conflict", 409],
    ["not-found", 404],
    ["future-date", 400],
  ] as const)("maps %s on update to %i", async (kind, status) => {
    const response = await app({ async updateReview() { return { kind }; } }).request(`/reviews/${reviewId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "published", expectedUpdatedAt: now.toISOString() }),
    });
    expect(response.status).toBe(status);
  });

  it("requires the edited version to delete and maps a stale delete to 409", async () => {
    expect((await app().request(`/reviews/${reviewId}`, { method: "DELETE", headers })).status).toBe(400);
    const deleteReview = vi.fn<ReviewsRouterDependencies["deleteReview"]>(async () => ({ kind: "conflict" }));
    const response = await app({ deleteReview }).request(`/reviews/${reviewId}?expectedUpdatedAt=${encodeURIComponent(now.toISOString())}`, { method: "DELETE", headers });
    expect(response.status).toBe(409);
    expect(deleteReview).toHaveBeenCalledWith(reviewId, now.toISOString(), expect.objectContaining({ actorId: actor.id }));
  });

  it("treats a malformed id as not found", async () => {
    expect((await app().request("/reviews/not-a-uuid", { headers })).status).toBe(404);
  });
});

describe("public reviews", () => {
  it("exposes only public fields", () => {
    expect(Object.keys(toPublicReview(storedReview())).sort()).toEqual(["context", "displayName", "featured", "id", "quote", "rating", "receivedOn", "serviceSlug"]);
  });

  it("returns the published list without a session", async () => {
    const items = [toPublicReview(storedReview())];
    const response = await createPublicReviewsRouter({ async listPublishedReviews() { return items; } }).request("/");
    expect(response.status).toBe(200);
    expect((await response.json()).data.items).toEqual(items);
  });
});
