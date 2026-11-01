import { describe, expect, it, vi } from "vitest";
import { RETENTION, retentionCutoffs, runRetention, type RetentionDependencies } from "./maintenance/retention.js";
import { createAdminRouter, type AdminRouterDependencies } from "./routes/v1/admin.js";

const now = new Date("2026-11-01T12:00:00.000Z");
const daysBefore = (days: number) => new Date(now.getTime() - days * 86_400_000).toISOString();

describe("retention cutoffs", () => {
  it("match the agreed periods", () => {
    const cutoffs = retentionCutoffs(now);
    expect(cutoffs.inquiriesBefore.toISOString()).toBe(daysBefore(730));
    expect(cutoffs.emailBodiesBefore.toISOString()).toBe(daysBefore(90));
    expect(cutoffs.auditEventsBefore.toISOString()).toBe(daysBefore(730));
    expect(cutoffs.channelClicksBefore.toISOString()).toBe(daysBefore(395));
    expect(cutoffs.cacheRevalidationsBefore.toISOString()).toBe(daysBefore(30));
    expect(cutoffs.sessionsExpiredBefore).toEqual(now);
    expect(RETENTION.inquiriesDays).toBe(730);
  });
});

function fakeDependencies(overrides: Partial<RetentionDependencies> = {}): RetentionDependencies {
  return {
    deleteInquiries: vi.fn(async () => 2),
    scrubEmailBodies: vi.fn(async () => 5),
    deleteAuditEvents: vi.fn(async () => 0),
    deleteChannelClicks: vi.fn(async () => 1),
    deleteCacheRevalidations: vi.fn(async () => 3),
    deleteExpiredSessions: vi.fn(async () => 4),
    ...overrides,
  };
}

describe("runRetention", () => {
  it("runs every step with its own cutoff and reports the counts", async () => {
    const dependencies = fakeDependencies();
    const counts = await runRetention(now, dependencies);
    expect(counts).toEqual({ inquiriesDeleted: 2, emailBodiesScrubbed: 5, auditEventsDeleted: 0, channelClicksDeleted: 1, cacheRevalidationsDeleted: 3, sessionsDeleted: 4 });
    expect(dependencies.deleteInquiries).toHaveBeenCalledWith(new Date(daysBefore(730)));
    expect(dependencies.scrubEmailBodies).toHaveBeenCalledWith(new Date(daysBefore(90)));
  });

  it("keeps going when one step fails, and marks it", async () => {
    const logger = { error: vi.fn() } as never;
    const dependencies = fakeDependencies({ scrubEmailBodies: vi.fn(async () => { throw new Error("database busy"); }) });
    const counts = await runRetention(now, dependencies, logger);
    expect(counts.emailBodiesScrubbed).toBe(-1);
    expect(counts.sessionsDeleted).toBe(4);
  });
});

describe("DELETE /inquiries/:id", () => {
  const token = "a-session-token-used-only-in-this-test";
  const inquiryId = "3c2d57bc-11af-4c75-8b81-03a676cc1f55";
  const headers = { Cookie: `mg_admin_session=${token}`, Origin: "http://localhost:3000" };

  function app(role: "owner" | "staff", deleteInquiry: AdminRouterDependencies["deleteInquiry"]) {
    const session = { id: "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5", email: "someone@example.test", sessionId: "c0ffee00-1d2e-4f3a-8b9c-0d1e2f3a4b5c", role, mustChangePassword: false };
    const dependencies = { async resolveSession(value: string) { return value === token ? session : null; }, deleteInquiry } as unknown as AdminRouterDependencies; // Only this route is exercised.
    return createAdminRouter(dependencies);
  }

  it("lets an owner delete an enquiry, recording who did it", async () => {
    const deleteInquiry = vi.fn<AdminRouterDependencies["deleteInquiry"]>(async () => true);
    const response = await app("owner", deleteInquiry).request(`/inquiries/${inquiryId}`, { method: "DELETE", headers });
    expect(response.status).toBe(200);
    expect(deleteInquiry).toHaveBeenCalledWith(inquiryId, expect.objectContaining({ actorId: "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5" }));
  });

  it("refuses staff, other origins, and unknown ids", async () => {
    const deleteInquiry = vi.fn<AdminRouterDependencies["deleteInquiry"]>(async () => false);
    expect((await app("staff", deleteInquiry).request(`/inquiries/${inquiryId}`, { method: "DELETE", headers })).status).toBe(403);
    expect((await app("owner", deleteInquiry).request(`/inquiries/${inquiryId}`, { method: "DELETE", headers: { ...headers, Origin: "https://attacker.example" } })).status).toBe(403);
    expect((await app("owner", deleteInquiry).request(`/inquiries/${inquiryId}`, { method: "DELETE", headers })).status).toBe(404);
    expect((await app("owner", deleteInquiry).request("/inquiries/not-a-uuid", { method: "DELETE", headers })).status).toBe(404);
  });
});
