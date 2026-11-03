import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "../app.js";
import { bootstrapAdmins } from "../auth/bootstrap-admins.js";
import { hashPassword, verifyPassword } from "../auth/password.js";
import { closeDb, getDb } from "../db/client.js";
import { adminAuditEvents, adminPasswordResets, adminUsers, cacheRevalidations, contactInquiries, emailOutbox, galleryItems, mediaAssets, reviews, siteSettings } from "../db/schema/index.js";
import { runRetention } from "../maintenance/retention.js";
import { sampleReviews, seedSampleReviews } from "../reviews/sample-reviews.js";

/**
 * The real app against real Postgres and Redis: queries, constraints, cascades, and the
 * session cookie flow that the unit tests replace with fakes.
 */
const origin = process.env.FRONTEND_ORIGINS?.split(",")[0]?.trim() || "http://localhost:3000";
const ownerEmail = "owner@integration.test";
const ownerPassword = "an-integration-owner-password";

afterAll(async () => {
  await closeDb();
});

function api(path: string, init: RequestInit & { cookie?: string } = {}) {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  if (init.body) headers.set("Content-Type", "application/json");
  if (init.cookie) headers.set("Cookie", init.cookie);
  return app.request(`/api/v1${path}`, { ...init, headers });
}

async function signIn(email: string, password: string) {
  const response = await api("/admin/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  return { response, cookie: cookie ?? "" };
}

async function ownerSession() {
  const [existing] = await getDb().select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, ownerEmail));
  if (!existing) await getDb().insert(adminUsers).values({ email: ownerEmail, role: "owner", passwordHash: await hashPassword(ownerPassword) });
  const { response, cookie } = await signIn(ownerEmail, ownerPassword);
  expect(response.status).toBe(200);
  return cookie;
}

describe("readiness", () => {
  it("reports Postgres and Redis as reachable", async () => {
    const response = await api("/health/ready");
    expect(response.status).toBe(200);
    expect((await response.json()).data.checks).toEqual({ database: "ok", redis: "ok" });
  });
});

describe("an enquiry from the website", () => {
  it("is stored with a team alert that carries reply buttons and the customer's reply-to", async () => {
    const response = await api("/inquiries", {
      method: "POST",
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({ name: "Ada Integration", phone: "0816 771 5346", email: "ada@integration.test", inquiryType: "contact", topic: "General question", message: "Testing the stored enquiry end to end." }),
    });
    expect(response.status).toBe(201);
    const { data } = await response.json();
    const rows = await getDb().select().from(emailOutbox).where(eq(emailOutbox.inquiryId, data.inquiryId));
    const alert = rows.find((row) => row.kind === "internal");
    expect(alert?.actions.map((action) => action.label)).toEqual(["Reply on WhatsApp", "Call", "Open in dashboard"]);
    expect(alert?.replyTo).toBe("ada@integration.test");
    expect(rows.some((row) => row.kind === "customer")).toBe(true);
  });

  it("stores one team alert per inbox when a Settings inbox is set as well", async () => {
    await getDb().insert(siteSettings).values({ id: 1, inquiryNotificationEmail: "team@integration.test" }).onConflictDoUpdate({ target: siteSettings.id, set: { inquiryNotificationEmail: "team@integration.test" } });
    try {
      const response = await api("/inquiries", {
        method: "POST",
        headers: { "Idempotency-Key": randomUUID() },
        body: JSON.stringify({ name: "Bola Integration", phone: "0816 771 5347", inquiryType: "contact", topic: "General question", message: "Testing alerts to two inboxes." }),
      });
      expect(response.status).toBe(201);
      const { data } = await response.json();
      const rows = await getDb().select().from(emailOutbox).where(eq(emailOutbox.inquiryId, data.inquiryId));
      expect(rows.filter((row) => row.kind === "internal").map((row) => row.to).sort()).toEqual(["inquiries@example.com", "team@integration.test"].sort());
    } finally {
      await getDb().update(siteSettings).set({ inquiryNotificationEmail: null }).where(eq(siteSettings.id, 1));
    }
  });
});

describe("bootstrap admins", () => {
  it("creates missing owners once and never changes an existing account", async () => {
    const existingEmail = "existing-owner@integration.test";
    const existingHash = await hashPassword("an-existing-owner-password");
    await getDb().insert(adminUsers).values({ email: existingEmail, role: "owner", passwordHash: existingHash });

    const first = await bootstrapAdmins(`New-Owner@Integration.test, ${existingEmail}`, "a-bootstrap-owner-password");
    expect(first).toEqual({ created: ["new-owner@integration.test"], existing: [existingEmail] });
    const second = await bootstrapAdmins(`new-owner@integration.test,${existingEmail}`, "a-different-password-now");
    expect(second.created).toEqual([]);

    const [created] = await getDb().select().from(adminUsers).where(eq(adminUsers.email, "new-owner@integration.test"));
    expect(created?.role).toBe("owner");
    expect(created?.mustChangePassword).toBe(true);
    expect(await verifyPassword("a-bootstrap-owner-password", created!.passwordHash)).toBe(true);
    const [untouched] = await getDb().select().from(adminUsers).where(eq(adminUsers.email, existingEmail));
    expect(untouched?.passwordHash).toBe(existingHash);
  });

  it("refuses a password that breaks the policy", async () => {
    await expect(bootstrapAdmins("short-pass@integration.test", "short")).rejects.toThrow(/Initial admin password/);
  });
});

describe("forgotten password", () => {
  it("emails a single-use link that resets the password and signs out every session", async () => {
    const owner = await ownerSession();
    const unknown = await api("/admin/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email: "nobody@integration.test" }) });
    expect(unknown.status).toBe(200);
    const requested = await api("/admin/auth/password-reset/request", { method: "POST", body: JSON.stringify({ email: ownerEmail }) });
    expect(requested.status).toBe(200);
    expect((await requested.json()).message).toBe((await unknown.json()).message);

    const [user] = await getDb().select({ id: adminUsers.id }).from(adminUsers).where(eq(adminUsers.email, ownerEmail));
    const emails = await getDb().select().from(emailOutbox).where(eq(emailOutbox.adminUserId, user!.id));
    expect(emails).toHaveLength(1);
    expect(emails[0]!.to).toBe(ownerEmail);
    const resetToken = new URL(emails[0]!.actions[0]!.href).hash.replace("#token=", "");
    const stored = await getDb().select().from(adminPasswordResets).where(eq(adminPasswordResets.userId, user!.id));
    expect(stored.map((row) => row.tokenHash)).not.toContain(resetToken);

    const newPassword = "a-new-integration-password";
    const confirmed = await api("/admin/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token: resetToken, newPassword }) });
    expect(confirmed.status).toBe(200);
    expect((await api("/admin/overview", { cookie: owner })).status).toBe(401);
    expect((await signIn(ownerEmail, newPassword)).response.status).toBe(200);
    const reused = await api("/admin/auth/password-reset/confirm", { method: "POST", body: JSON.stringify({ token: resetToken, newPassword: "another-new-password-1" }) });
    expect(reused.status).toBe(400);

    // Put the shared owner password back for the tests that follow.
    await getDb().update(adminUsers).set({ passwordHash: await hashPassword(ownerPassword) }).where(eq(adminUsers.id, user!.id));
  });
});

describe("accounts", () => {
  it("creates staff with a temporary password, blocks them until they change it, and signs them out when deactivated", async () => {
    const owner = await ownerSession();
    const created = await api("/admin/users", { method: "POST", cookie: owner, body: JSON.stringify({ email: "staff@integration.test" }) });
    expect(created.status).toBe(201);
    const { data } = await created.json();

    const staff = await signIn("staff@integration.test", data.temporaryPassword);
    expect(staff.response.status).toBe(200);
    expect((await api("/admin/overview", { cookie: staff.cookie })).status).toBe(403);
    expect((await api("/admin/users", { cookie: staff.cookie })).status).toBe(403);

    const deactivated = await api(`/admin/users/${data.user.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ active: false }) });
    expect(deactivated.status).toBe(200);
    const session = await (await api("/admin/auth/session", { cookie: staff.cookie })).json();
    expect(session.data.authenticated).toBe(false);
    expect((await signIn("staff@integration.test", data.temporaryPassword)).response.status).toBe(401);
  });

  it("stores the account's role and refuses an invalid one at the database", async () => {
    await expect(getDb().execute(sql`insert into admin_users (email, password_hash, role) values ('bad@integration.test', 'x', 'superuser')`)).rejects.toThrow();
  });
});

describe("reviews", () => {
  it("publishes with consent, queues a cache purge, and disappears from the public list when unpublished", async () => {
    const owner = await ownerSession();
    const created = await api("/admin/reviews", {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({ displayName: "Ngozi Integration", quote: "Careful, punctual, and thorough from start to finish.", source: "whatsapp", rating: 5, status: "published", consentConfirmed: true }),
    });
    expect(created.status).toBe(201);
    const review = (await created.json()).data;

    const published = await (await api("/reviews")).json();
    expect(published.data.items.map((item: { id: string }) => item.id)).toContain(review.id);
    const purges = await getDb().select().from(cacheRevalidations);
    expect(purges.some((row) => JSON.stringify(row.tags) === JSON.stringify(["reviews"]) && row.mode === "refresh")).toBe(true);

    const unpublished = await api(`/admin/reviews/${review.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ status: "draft", expectedUpdatedAt: review.updatedAt }) });
    expect(unpublished.status).toBe(200);
    const after = await (await api("/reviews")).json();
    expect(after.data.items.map((item: { id: string }) => item.id)).not.toContain(review.id);
    expect((await getDb().select().from(cacheRevalidations)).some((row) => row.mode === "remove")).toBe(true);
  });

  it("refuses a published review without consent at the database too", async () => {
    await expect(
      getDb().insert(reviews).values({ displayName: "No Consent", quote: "This should never be stored as published.", source: "other", status: "published" }),
    ).rejects.toThrow();
  });

  it("seeds sample reviews only into an empty table, so restarts never add them again", async () => {
    await getDb().delete(reviews);
    expect((await seedSampleReviews()).inserted).toBe(sampleReviews.length);
    expect((await seedSampleReviews()).inserted).toBe(0);
    expect(await getDb().select().from(reviews)).toHaveLength(sampleReviews.length);

    const publicList = await (await api("/reviews")).json();
    expect(publicList.data.items).toHaveLength(sampleReviews.filter((sample) => sample.status === "published").length);
  });
});

async function verifiedMedia(contentType: string) {
  const extension = contentType.split("/")[1];
  const key = `integration/gallery/${randomUUID()}.${extension}`;
  const [asset] = await getDb()
    .insert(mediaAssets)
    .values({ key, publicUrl: `https://media.integration.test/${key}`, intent: "gallery", contentType, declaredBytes: 2048, byteSize: 2048, status: "verified", verifiedAt: new Date(), expiresAt: new Date(Date.now() + 60_000) })
    .returning();
  return asset!;
}

describe("gallery", () => {
  it("refuses to delete a photo, video, or poster that a gallery item uses", async () => {
    const owner = await ownerSession();
    const video = await verifiedMedia("video/mp4");
    const poster = await verifiedMedia("image/webp");
    await getDb().insert(galleryItems).values({ type: "video", mediaId: video.id, posterMediaId: poster.id, altText: "A team member polishing a tiled lobby floor", position: 1 });

    for (const id of [video.id, poster.id]) {
      const response = await api(`/admin/media/${id}`, { method: "DELETE", cookie: owner });
      expect(response.status).toBe(409);
    }
    const [stillThere] = await getDb().select().from(mediaAssets).where(eq(mediaAssets.id, video.id));
    expect(stillThere?.status).toBe("verified");
    await expect(getDb().delete(mediaAssets).where(eq(mediaAssets.id, poster.id))).rejects.toThrow();
  });

  it("refuses unconfirmed rights, a posterless published video, and a second item on one upload at the database", async () => {
    const photo = await verifiedMedia("image/jpeg");
    const video = await verifiedMedia("video/webm");
    const rightsConfirmedAt = new Date();
    await expect(getDb().insert(galleryItems).values({ type: "image", mediaId: photo.id, altText: "A clean office", position: 1, status: "published" })).rejects.toThrow();
    await expect(getDb().insert(galleryItems).values({ type: "video", mediaId: video.id, altText: "A clean office", position: 2, status: "published", rightsConfirmedAt })).rejects.toThrow();
    await expect(getDb().insert(galleryItems).values({ type: "image", mediaId: photo.id, altText: "A clean office", position: 3, layout: "huge" })).rejects.toThrow();

    await getDb().insert(galleryItems).values({ type: "image", mediaId: photo.id, altText: "A clean office", position: 4, status: "published", rightsConfirmedAt });
    await expect(getDb().insert(galleryItems).values({ type: "image", mediaId: photo.id, altText: "The same office again", position: 5 })).rejects.toThrow();
  });

  it("takes a video from draft to the public gallery, reorders it, and removes it with its files", async () => {
    const owner = await ownerSession();
    const video = await verifiedMedia("video/mp4");
    const poster = await verifiedMedia("image/webp");

    const created = await api("/admin/gallery", { method: "POST", cookie: owner, body: JSON.stringify({ mediaId: video.id, altText: "A team member polishing a tiled lobby floor", tags: ["Office"] }) });
    expect(created.status).toBe(201);
    const draft = (await created.json()).data;
    expect(draft).toMatchObject({ type: "video", status: "draft", mediaUrl: video.publicUrl, posterUrl: null });

    const duplicate = await api("/admin/gallery", { method: "POST", cookie: owner, body: JSON.stringify({ mediaId: video.id, altText: "The same clip again" }) });
    expect(duplicate.status).toBe(409);

    const noRights = await api(`/admin/gallery/${draft.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ status: "published", posterMediaId: poster.id, expectedUpdatedAt: draft.updatedAt }) });
    expect(noRights.status).toBe(422);

    const published = await api(`/admin/gallery/${draft.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ status: "published", posterMediaId: poster.id, rightsConfirmed: true, expectedUpdatedAt: draft.updatedAt }) });
    expect(published.status).toBe(200);
    const live = (await published.json()).data;
    expect(live).toMatchObject({ status: "published", posterUrl: poster.publicUrl });

    const stale = await api(`/admin/gallery/${draft.id}`, { method: "PATCH", cookie: owner, body: JSON.stringify({ caption: "Too late", expectedUpdatedAt: draft.updatedAt }) });
    expect(stale.status).toBe(409);

    const publicItems = (await (await api("/gallery")).json()).data.items;
    expect(publicItems.find((item: { id: string }) => item.id === draft.id)).toEqual({
      id: draft.id, type: "video", src: video.publicUrl, poster: poster.publicUrl, alt: "A team member polishing a tiled lobby floor", caption: null, serviceSlug: null, tags: ["Office"], layout: "standard",
    });
    expect((await getDb().select().from(cacheRevalidations)).some((row) => row.tags.includes("gallery"))).toBe(true);

    const listed = (await (await api("/admin/gallery", { cookie: owner })).json()).data.items as Array<{ id: string }>;
    const reversed = listed.map((item) => item.id).reverse();
    expect((await api("/admin/gallery/order", { method: "PUT", cookie: owner, body: JSON.stringify({ ids: reversed.slice(1) }) })).status).toBe(409);
    const reordered = await api("/admin/gallery/order", { method: "PUT", cookie: owner, body: JSON.stringify({ ids: reversed }) });
    expect(reordered.status).toBe(200);
    expect((await reordered.json()).data.items.map((item: { id: string }) => item.id)).toEqual(reversed);

    const deleted = await api(`/admin/gallery/${draft.id}?expectedUpdatedAt=${encodeURIComponent(live.updatedAt)}`, { method: "DELETE", cookie: owner });
    expect(deleted.status).toBe(200);
    const files = await getDb().select({ id: mediaAssets.id, status: mediaAssets.status }).from(mediaAssets).where(sql`${mediaAssets.id} IN (${video.id}, ${poster.id})`);
    expect(files.map((file) => file.status)).toEqual(["deleted", "deleted"]);
    expect((await (await api("/gallery")).json()).data.items.some((item: { id: string }) => item.id === draft.id)).toBe(false);
  });

  it("refuses a gallery video as an article cover", async () => {
    const owner = await ownerSession();
    const video = await verifiedMedia("video/mp4");
    const response = await api("/admin/blog/posts", {
      method: "POST",
      cookie: owner,
      body: JSON.stringify({ title: "Video cover attempt", slug: `video-cover-${randomUUID().slice(0, 8)}`, excerpt: "An article that should not take a video cover.", body: "This body is long enough to pass validation for a draft.", category: "Home care", serviceSlug: "home-cleaning", coverMediaId: video.id }),
    });
    expect(response.status).toBe(400);
  });
});

describe("deleting and retaining personal data", () => {
  it("lets an owner delete an enquiry, removing its emails and keeping only the reference in the audit log", async () => {
    const owner = await ownerSession();
    const [inquiry] = await getDb().insert(contactInquiries).values({ name: "Erase Me", phone: "08000000009", publicReference: "MG-INT-ERASE", idempotencyKey: randomUUID(), message: "Please delete my details." }).returning();
    await getDb().insert(emailOutbox).values({ inquiryId: inquiry!.id, kind: "internal", to: "team@integration.test", subject: "s", title: "t", message: "Name: Erase Me" });

    expect((await api(`/admin/inquiries/${inquiry!.id}`, { method: "DELETE", cookie: owner })).status).toBe(200);
    expect(await getDb().select().from(contactInquiries).where(eq(contactInquiries.id, inquiry!.id))).toHaveLength(0);
    expect(await getDb().select().from(emailOutbox).where(eq(emailOutbox.inquiryId, inquiry!.id))).toHaveLength(0);
    const [audit] = await getDb().select().from(adminAuditEvents).where(eq(adminAuditEvents.action, "inquiry.delete"));
    expect(audit?.metadata).toEqual({ reference: "MG-INT-ERASE" });
  });

  it("removes enquiries past 24 months and keeps newer ones", async () => {
    const old = { name: "Old", phone: "08000000010", publicReference: "MG-INT-OLD", idempotencyKey: randomUUID(), message: "Old enquiry text.", createdAt: new Date(Date.now() - 800 * 86_400_000) };
    const recent = { name: "Recent", phone: "08000000011", publicReference: "MG-INT-NEW", idempotencyKey: randomUUID(), message: "Recent enquiry text." };
    await getDb().insert(contactInquiries).values([old, recent]);
    const counts = await runRetention();
    expect(counts.inquiriesDeleted).toBeGreaterThanOrEqual(1);
    const references = (await getDb().select({ reference: contactInquiries.publicReference }).from(contactInquiries)).map((row) => row.reference);
    expect(references).toContain("MG-INT-NEW");
    expect(references).not.toContain("MG-INT-OLD");
  });
});
