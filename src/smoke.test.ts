import { describe, expect, it } from "vitest";
import { createAdminRouter, type AdminRouterDependencies } from "./routes/v1/admin.js";

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
