import { describe, expect, it, vi } from "vitest";
import { matchesImageSignature } from "../media/policy.js";
import { createAdminRouter, type AdminRouterDependencies } from "../routes/v1/admin.js";
import {
  assertSafeTarget,
  notificationOutcome,
  parseSessionCookie,
  pollUntil,
  sessionCookieProblems,
  TINY_PNG,
} from "../smoke/helpers.js";

describe("smoke target guard", () => {
  it("allows local and clearly non-production hosts", () => {
    for (const url of ["http://localhost:4000/api/v1", "https://api.staging.mg.example/api/v1", "https://mg-staging.example", "https://preview-42.mg.example"]) {
      expect(() => assertSafeTarget(url, false)).not.toThrow();
    }
  });

  it("refuses production-looking hosts unless explicitly allowed", () => {
    expect(() => assertSafeTarget("https://api.mgcleaning.example/api/v1", false)).toThrow(/does not look like staging/);
    expect(() => assertSafeTarget("https://stagingmg.example", false)).toThrow();
    expect(() => assertSafeTarget("https://api.mgcleaning.example/api/v1", true)).not.toThrow();
  });
});

describe("session cookie checks", () => {
  const header = "mg_admin_session=abc123; Max-Age=43200; Path=/api/v1/admin; HttpOnly; Secure; SameSite=Lax";

  it("parses the admin cookie and its attributes", () => {
    expect(parseSessionCookie(["other=1; Path=/", header], "mg_admin_session")).toEqual({
      value: "abc123",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      path: "/api/v1/admin",
    });
    expect(parseSessionCookie(["other=1"], "mg_admin_session")).toBeNull();
  });

  it("flags unsafe deployed cookies", () => {
    const cookie = parseSessionCookie(["mg_admin_session=abc; Path=/; SameSite=None"], "mg_admin_session")!;
    expect(sessionCookieProblems(cookie, "https://api.staging.example")).toEqual([
      "cookie is not HttpOnly",
      "cookie SameSite is None, expected Lax",
      "cookie is not Secure on an HTTPS deployment",
      "cookie Path is /, expected /api/v1/admin",
    ]);
    expect(sessionCookieProblems(parseSessionCookie([header], "mg_admin_session")!, "https://api.staging.example")).toEqual([]);
  });
});

describe("smoke helpers", () => {
  it("uploads a real PNG so verification checks image bytes", () => {
    expect(matchesImageSignature("image/png", TINY_PNG)).toBe(true);
  });

  it("treats dead-lettered email as failure and waits for every email", () => {
    expect(notificationOutcome([{ kind: "internal", status: "sent" }, { kind: "customer", status: "failed" }])).toBe("pending");
    expect(notificationOutcome([{ kind: "internal", status: "dead_letter" }])).toBe("failed");
    expect(notificationOutcome([{ kind: "internal", status: "sent" }])).toBe("sent");
    expect(notificationOutcome([])).toBe("pending");
  });

  it("polls until a result or the deadline", async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => { clock += ms; });
    let calls = 0;
    await expect(pollUntil(async () => (++calls === 3 ? "done" : null), { timeoutMs: 10_000, intervalMs: 1_000, sleep, now: () => clock })).resolves.toBe("done");
    await expect(pollUntil(async () => null, { timeoutMs: 2_000, intervalMs: 1_000, sleep, now: () => clock })).rejects.toThrow("Timed out");
  });
});

describe("inquiry delivery status", () => {
  it("returns delivery state with the inquiry, without addresses", async () => {
    const token = "a-session-token-used-only-in-this-test";
    const router = createAdminRouter({
      async resolveSession(value: string) { return value === token ? { id: "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5", email: "admin@example.test", sessionId: "c0ffee00-1d2e-4f3a-8b9c-0d1e2f3a4b5c" } : null; },
      async getInquiry(id: string) { return { id, name: "Mary Example" }; },
      async getInquiryNotifications() { return [{ kind: "internal", status: "sent", attempts: 1, sentAt: new Date("2026-10-27T09:00:00.000Z") }]; },
    } as unknown as AdminRouterDependencies); // Only session, inquiry, and notification reads are exercised.
    const response = await router.request("/inquiries/5a3c2a3e-8a0b-4d8e-9a43-1c7c5b5f9a10", { headers: { Cookie: `mg_admin_session=${token}` } });
    const body = await response.json();
    expect(body.data.notifications).toEqual([{ kind: "internal", status: "sent", attempts: 1, sentAt: "2026-10-27T09:00:00.000Z" }]);
    expect(JSON.stringify(body.data.notifications)).not.toContain("@");
  });
});
