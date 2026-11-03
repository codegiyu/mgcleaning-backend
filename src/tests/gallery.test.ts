import { describe, expect, it, vi } from "vitest";
import { GALLERY_TAG, revalidationForGalleryChange } from "../cache/revalidation.js";
import {
  galleryItemInputSchema,
  galleryItemPatchSchema,
  galleryReorderSchema,
  planGalleryWrite,
  reorderMatches,
  toPublicGalleryItem,
  type GalleryItemView,
} from "../gallery/policy.js";
import { createAdminRouter, type AdminRouterDependencies } from "../routes/v1/admin.js";
import { createGalleryAdminRouter, createPublicGalleryRouter, type GalleryRouterDependencies } from "../routes/v1/gallery.js";

const token = "a-session-token-used-only-in-this-test";
const actor = { id: "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5", email: "staff@example.test", sessionId: "c0ffee00-1d2e-4f3a-8b9c-0d1e2f3a4b5c", role: "staff" as const, mustChangePassword: false };
const headers = { Cookie: `mg_admin_session=${token}`, Origin: "http://localhost:3000", "Content-Type": "application/json" };
const itemId = "5a1c2b3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const mediaId = "6b2d3c4e-5f60-4b7c-9d8e-0f1a2b3c4d5e";
const posterId = "7c3e4d5f-6071-4c8d-8e9f-1a2b3c4d5e6f";
const now = new Date("2026-11-03T09:00:00.000Z");

function storedItem(overrides: Partial<GalleryItemView> = {}): GalleryItemView {
  return {
    id: itemId,
    type: "video",
    mediaId,
    posterMediaId: posterId,
    altText: "A team member polishing a tiled lobby floor",
    caption: "Lobby floor care",
    serviceSlug: "tile-polishing",
    tags: ["Office"],
    layout: "standard",
    position: 1,
    status: "published",
    rightsConfirmedAt: now,
    rightsConfirmedBy: actor.id,
    publishedAt: now,
    createdBy: actor.id,
    updatedBy: actor.id,
    createdAt: now,
    updatedAt: now,
    mediaUrl: "https://media.example.test/gallery/lobby.mp4",
    mediaContentType: "video/mp4",
    posterUrl: "https://media.example.test/gallery/lobby.webp",
    ...overrides,
  };
}

function app(gallery: Partial<GalleryRouterDependencies> = {}) {
  const dependencies: GalleryRouterDependencies = {
    async listItems() { return [storedItem(), storedItem({ id: posterId, status: "draft" })]; },
    async getItem(id) { return id === itemId ? storedItem() : null; },
    async createItem() { return { kind: "created", item: storedItem({ status: "draft" }) }; },
    async updateItem() { return { kind: "updated", item: storedItem() }; },
    async reorderItems() { return { kind: "reordered", items: [storedItem()] }; },
    async deleteItem() { return { kind: "deleted" }; },
    ...gallery,
  };
  const adminDependencies = {
    async resolveSession(value: string) { return value === token ? actor : null; },
  } as unknown as AdminRouterDependencies; // Only the gallery routes are exercised.
  return createAdminRouter(adminDependencies, undefined, undefined, undefined, undefined, undefined, undefined, createGalleryAdminRouter(dependencies));
}

const draft = { type: "image" as const, status: "draft", posterMediaId: null, rightsConfirmedAt: null, updatedAt: now };

describe("gallery write plan", () => {
  it("creates a draft that keeps the type from the file and records who added it", () => {
    const plan = planGalleryWrite(null, { altText: "A bright living room" }, { type: "image", now, actorId: actor.id });
    expect(plan).toMatchObject({ kind: "apply", action: "gallery.create", statusTo: "draft", values: { type: "image", status: "draft", createdBy: actor.id, publishedAt: null } });
  });

  it("refuses to publish without confirmed rights", () => {
    expect(planGalleryWrite(null, { altText: "A bright living room", status: "published" }, { type: "image", now, actorId: actor.id })).toEqual({ kind: "rights-required" });
  });

  it("refuses to publish a video without a poster, and accepts one with a poster", () => {
    const input = { altText: "Lobby floor care", status: "published" as const, rightsConfirmed: true };
    expect(planGalleryWrite(null, input, { type: "video", now, actorId: actor.id })).toEqual({ kind: "poster-required" });
    expect(planGalleryWrite(null, { ...input, posterMediaId: posterId }, { type: "video", now, actorId: actor.id })).toMatchObject({
      kind: "apply",
      values: { status: "published", publishedAt: now, rightsConfirmedAt: now, rightsConfirmedBy: actor.id },
    });
  });

  it("refuses a poster on a photo", () => {
    expect(planGalleryWrite(null, { altText: "A sofa", posterMediaId: posterId }, { type: "image", now, actorId: actor.id })).toEqual({ kind: "poster-not-allowed" });
  });

  it("refuses an edit made from an older version", () => {
    const plan = planGalleryWrite(draft, { caption: "New" }, { type: "image", now, actorId: actor.id, expectedUpdatedAt: "2026-11-02T09:00:00.000Z" });
    expect(plan).toEqual({ kind: "conflict" });
  });

  it("keeps rights and the poster in place while a video is live", () => {
    const live = { ...draft, type: "video" as const, status: "published", posterMediaId: posterId, rightsConfirmedAt: now };
    const options = { type: "video" as const, now, actorId: actor.id, expectedUpdatedAt: now.toISOString() };
    expect(planGalleryWrite(live, { rightsConfirmed: false }, options)).toEqual({ kind: "rights-required" });
    expect(planGalleryWrite(live, { posterMediaId: null }, options)).toEqual({ kind: "poster-required" });
    expect(planGalleryWrite(live, { status: "draft" }, options)).toMatchObject({ kind: "apply", action: "gallery.unpublish", values: { publishedAt: null } });
  });

  it("names the publish action when a confirmed draft goes live", () => {
    const confirmed = { ...draft, rightsConfirmedAt: now };
    expect(planGalleryWrite(confirmed, { status: "published" }, { type: "image", now, actorId: actor.id, expectedUpdatedAt: now.toISOString() })).toMatchObject({ kind: "apply", action: "gallery.publish" });
  });
});

describe("gallery input", () => {
  it("accepts a complete item and removes repeated tags", () => {
    const parsed = galleryItemInputSchema.parse({ mediaId, altText: "  A clean kitchen  ", caption: "", tags: ["Home", "Home", "Kitchen"], layout: "wide" });
    expect(parsed).toMatchObject({ altText: "A clean kitchen", caption: null, tags: ["Home", "Kitchen"], layout: "wide" });
  });

  it.each([
    ["markup in the alt text", { altText: "<img src=x onerror=alert(1)>" }],
    ["a link in the caption", { caption: "See https://example.com" }],
    ["a line break in a tag", { tags: ["Home\nOffice"] }],
    ["an unknown layout", { layout: "huge" }],
    ["a client-chosen type", { type: "video" }],
    ["too many tags", { tags: ["1", "2", "3", "4", "5", "6", "7", "8", "9"] }],
  ])("refuses %s", (_label, change) => {
    expect(galleryItemInputSchema.safeParse({ mediaId, altText: "A clean kitchen", ...change }).success).toBe(false);
  });

  it("requires a version on every patch and does not let the file change", () => {
    expect(galleryItemPatchSchema.safeParse({ caption: "New" }).success).toBe(false);
    expect(galleryItemPatchSchema.safeParse({ expectedUpdatedAt: now.toISOString() }).success).toBe(false);
    expect(galleryItemPatchSchema.safeParse({ mediaId, expectedUpdatedAt: now.toISOString() }).success).toBe(false);
    expect(galleryItemPatchSchema.safeParse({ caption: "New", expectedUpdatedAt: now.toISOString() }).success).toBe(true);
  });

  it("refuses a reorder that names an item twice", () => {
    expect(galleryReorderSchema.safeParse({ ids: [itemId, itemId] }).success).toBe(false);
  });

  it("matches a reorder only to the exact current set of items", () => {
    expect(reorderMatches([itemId, mediaId], [mediaId, itemId])).toBe(true);
    expect(reorderMatches([itemId, mediaId], [itemId])).toBe(false);
    expect(reorderMatches([itemId], [itemId, mediaId])).toBe(false);
    expect(reorderMatches([itemId, mediaId], [itemId, posterId])).toBe(false);
  });
});

describe("gallery cache purges", () => {
  it("refreshes for live changes, removes at once when an item leaves, and skips drafts", () => {
    expect(revalidationForGalleryChange(null, { status: "published" })).toEqual({ tags: [GALLERY_TAG], mode: "refresh" });
    expect(revalidationForGalleryChange({ status: "published" }, { status: "draft" })).toEqual({ tags: [GALLERY_TAG], mode: "remove" });
    expect(revalidationForGalleryChange({ status: "published" }, null)).toEqual({ tags: [GALLERY_TAG], mode: "remove" });
    expect(revalidationForGalleryChange({ status: "draft" }, { status: "draft" })).toBeNull();
  });

  it("uses the tag the website allows", () => {
    expect(GALLERY_TAG).toBe("gallery");
  });
});

describe("admin gallery routes", () => {
  it("requires a session", async () => {
    const response = await app().request("/gallery");
    expect(response.status).toBe(401);
  });

  it("lists items with counts for a staff member", async () => {
    const response = await app().request("/gallery", { headers });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.counts).toEqual({ published: 1, draft: 1 });
    expect(body.data.items).toHaveLength(2);
  });

  it("refuses writes from other origins", async () => {
    const createItem = vi.fn<GalleryRouterDependencies["createItem"]>();
    const response = await app({ createItem }).request("/gallery", { method: "POST", headers: { ...headers, Origin: "https://evil.example" }, body: JSON.stringify({ mediaId, altText: "A sofa" }) });
    expect(response.status).toBe(403);
    expect(createItem).not.toHaveBeenCalled();
  });

  it("passes a valid item to storage with the acting admin", async () => {
    const createItem = vi.fn<GalleryRouterDependencies["createItem"]>(async () => ({ kind: "created", item: storedItem({ status: "draft" }) }));
    const response = await app({ createItem }).request("/gallery", { method: "POST", headers, body: JSON.stringify({ mediaId, altText: "A sofa after cleaning" }) });
    expect(response.status).toBe(201);
    expect(createItem).toHaveBeenCalledWith(expect.objectContaining({ mediaId, altText: "A sofa after cleaning" }), expect.objectContaining({ actorId: actor.id }));
  });

  it.each([
    ["rights-required", 422],
    ["poster-required", 422],
    ["invalid-media", 400],
    ["media-in-use", 409],
    ["gallery-full", 409],
  ] as const)("answers %s with %i", async (kind, status) => {
    const response = await app({ async createItem() { return { kind }; } }).request("/gallery", { method: "POST", headers, body: JSON.stringify({ mediaId, altText: "A sofa" }) });
    expect(response.status).toBe(status);
  });

  it("reports an edit conflict", async () => {
    const response = await app({ async updateItem() { return { kind: "conflict" }; } }).request(`/gallery/${itemId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ caption: "New", expectedUpdatedAt: now.toISOString() }),
    });
    expect(response.status).toBe(409);
  });

  it("saves an order and reports a stale one", async () => {
    const reorderItems = vi.fn<GalleryRouterDependencies["reorderItems"]>(async () => ({ kind: "reordered", items: [storedItem()] }));
    const saved = await app({ reorderItems }).request("/gallery/order", { method: "PUT", headers, body: JSON.stringify({ ids: [itemId, mediaId] }) });
    expect(saved.status).toBe(200);
    expect(reorderItems).toHaveBeenCalledWith([itemId, mediaId], expect.objectContaining({ actorId: actor.id }));

    const stale = await app({ async reorderItems() { return { kind: "conflict" }; } }).request("/gallery/order", { method: "PUT", headers, body: JSON.stringify({ ids: [itemId] }) });
    expect(stale.status).toBe(409);
  });

  it("lets a staff member delete with the version they loaded", async () => {
    const deleteItem = vi.fn<GalleryRouterDependencies["deleteItem"]>(async () => ({ kind: "deleted" }));
    const missingVersion = await app({ deleteItem }).request(`/gallery/${itemId}`, { method: "DELETE", headers });
    expect(missingVersion.status).toBe(400);
    const response = await app({ deleteItem }).request(`/gallery/${itemId}?expectedUpdatedAt=${encodeURIComponent(now.toISOString())}`, { method: "DELETE", headers });
    expect(response.status).toBe(200);
    expect(deleteItem).toHaveBeenCalledWith(itemId, now.toISOString(), expect.objectContaining({ actorId: actor.id }));
  });
});

describe("public gallery", () => {
  it("returns only public fields", async () => {
    const item = toPublicGalleryItem(storedItem());
    const response = await createPublicGalleryRouter({ async listPublishedItems() { return [item]; } }).request("/");
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.items[0]).toEqual({
      id: itemId,
      type: "video",
      src: "https://media.example.test/gallery/lobby.mp4",
      poster: "https://media.example.test/gallery/lobby.webp",
      alt: "A team member polishing a tiled lobby floor",
      caption: "Lobby floor care",
      serviceSlug: "tile-polishing",
      tags: ["Office"],
      layout: "standard",
    });
  });
});
