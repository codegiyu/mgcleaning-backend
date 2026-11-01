import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, describe, expect, it } from "vitest";
import { app } from "./app.js";
import { hashPassword } from "./auth/password.js";
import { closeDb, getDb } from "./db/client.js";
import { adminAuditEvents, adminUsers, cacheRevalidations, contactInquiries, emailOutbox, reviews } from "./db/schema/index.js";
import { runRetention } from "./maintenance/retention.js";

/**
 * The real app against real Postgres and Redis: queries, constraints, cascades, and the
 * session cookie flow that the unit tests replace with fakes.
 */
const origin = process.env.FRONTEND_ORIGIN ?? "http://localhost:3000";
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
