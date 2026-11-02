import { describe, expect, it, vi } from "vitest";
import { passwordPolicyError } from "./auth/password-policy.js";
import { createAccountRouter, type AccountRouterDependencies } from "./routes/v1/account.js";
import { createAdminRouter, type AdminRouterDependencies } from "./routes/v1/admin.js";
import { createOperationsRouter, type OperationsRouterDependencies, type SettingsView } from "./routes/v1/operations.js";
import { notificationRecipients } from "./settings/site-settings.js";

const token = "a-session-token-used-only-in-this-test";
const actor = { id: "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5", email: "admin@example.test", sessionId: "c0ffee00-1d2e-4f3a-8b9c-0d1e2f3a4b5c", role: "owner" as const, mustChangePassword: false };
const otherSessionId = "0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const headers = { Cookie: `mg_admin_session=${token}`, Origin: "http://localhost:3000", "Content-Type": "application/json" };

const settings: SettingsView = {
  inquiryNotificationEmail: null,
  notificationRecipients: ["inquiries@example.com"],
  defaultAuthorName: null,
  updatedAt: null,
};

function app(account: Partial<AccountRouterDependencies> = {}, operations: Partial<OperationsRouterDependencies> = {}, admin: Partial<AdminRouterDependencies> = {}) {
  const accountDependencies: AccountRouterDependencies = {
    async changePassword() { return { kind: "changed", revokedSessions: 2 }; },
    async listSessions() { return []; },
    async revokeSession() { return true; },
    async revokeOtherSessions() { return 1; },
    ...account,
  };
  const operationsDependencies: OperationsRouterDependencies = {
    async listAudit() { return { items: [], total: 0 }; },
    async getSettings() { return settings; },
    async updateSettings(patch) { return { ...settings, ...patch }; },
    ...operations,
  };
  const adminDependencies = {
    async resolveSession(value: string) { return value === token ? actor : null; },
    ...admin,
  } as unknown as AdminRouterDependencies; // Only the routes under test are exercised.
  return createAdminRouter(adminDependencies, undefined, createAccountRouter(accountDependencies), createOperationsRouter(operationsDependencies));
}

const validChange = { currentPassword: "the-current-password", newPassword: "a-brand-new-long-password" };

describe("password change", () => {
  it("rejects other origins and short passwords before touching credentials", async () => {
    const changePassword = vi.fn<AccountRouterDependencies["changePassword"]>();
    const router = app({ changePassword });
    expect((await router.request("/account/password", { method: "POST", headers: { ...headers, Origin: "https://attacker.example" }, body: JSON.stringify(validChange) })).status).toBe(403);
    expect((await router.request("/account/password", { method: "POST", headers, body: JSON.stringify({ ...validChange, newPassword: "short" }) })).status).toBe(400);
    expect(changePassword).not.toHaveBeenCalled();
  });

  it("takes the account and session to keep from the session, never the body", async () => {
    const changePassword = vi.fn<AccountRouterDependencies["changePassword"]>(async () => ({ kind: "changed", revokedSessions: 2 }));
    const response = await app({ changePassword }).request("/account/password", { method: "POST", headers, body: JSON.stringify(validChange) });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ revokedSessions: 2 });
    expect(changePassword).toHaveBeenCalledWith(
      { userId: actor.id, keepSessionId: actor.sessionId, ...validChange },
      expect.objectContaining({ actorId: actor.id }),
    );
  });

  it("refuses extra fields such as a target user ID", async () => {
    const response = await app().request("/account/password", { method: "POST", headers, body: JSON.stringify({ ...validChange, userId: "someone-else" }) });
    expect(response.status).toBe(400);
  });

  it.each([
    ["invalid-current", 400],
    ["reused", 400],
    ["rate-limited", 429],
  ] as const)("maps %s to %i", async (kind, status) => {
    const response = await app({ async changePassword() { return { kind }; } }).request("/account/password", { method: "POST", headers, body: JSON.stringify(validChange) });
    expect(response.status).toBe(status);
  });

  it("requires a session", async () => {
    const response = await app().request("/account/password", { method: "POST", headers: { ...headers, Cookie: "" }, body: JSON.stringify(validChange) });
    expect(response.status).toBe(401);
  });
});

describe("session management", () => {
  it("marks the current session", async () => {
    const now = new Date("2026-10-27T09:00:00.000Z");
    const listSessions = vi.fn(async () => [
      { id: actor.sessionId, createdAt: now, lastUsedAt: now, expiresAt: now, userAgent: "Firefox" },
      { id: otherSessionId, createdAt: now, lastUsedAt: now, expiresAt: now, userAgent: null },
    ]);
    const response = await app({ listSessions }).request("/account/sessions", { headers });
    const body = await response.json();
    expect(listSessions).toHaveBeenCalledWith(actor.id);
    expect(body.data.map((session: { current: boolean }) => session.current)).toEqual([true, false]);
  });

  it("will not revoke the current session through the session list", async () => {
    const revokeSession = vi.fn(async () => true);
    const response = await app({ revokeSession }).request(`/account/sessions/${actor.sessionId}`, { method: "DELETE", headers });
    expect(response.status).toBe(400);
    expect(revokeSession).not.toHaveBeenCalled();
  });

  it("revokes another session scoped to the signed-in admin", async () => {
    const revokeSession = vi.fn(async () => true);
    const response = await app({ revokeSession }).request(`/account/sessions/${otherSessionId}`, { method: "DELETE", headers });
    expect(response.status).toBe(200);
    expect(revokeSession).toHaveBeenCalledWith(actor.id, otherSessionId, expect.any(Object));
  });

  it("returns 404 for a session that is not the admin's", async () => {
    const response = await app({ async revokeSession() { return false; } }).request(`/account/sessions/${otherSessionId}`, { method: "DELETE", headers });
    expect(response.status).toBe(404);
  });

  it("keeps the current session when signing out everywhere else", async () => {
    const revokeOtherSessions = vi.fn(async () => 3);
    const response = await app({ revokeOtherSessions }).request("/account/sessions/revoke-others", { method: "POST", headers });
    expect((await response.json()).data).toEqual({ revokedSessions: 3 });
    expect(revokeOtherSessions).toHaveBeenCalledWith(actor.id, actor.sessionId, expect.any(Object));
  });

  it("records the browser user agent at sign-in, truncated", async () => {
    const login = vi.fn<AdminRouterDependencies["login"]>(async () => ({ kind: "invalid" }));
    await app({}, {}, { login }).request("/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost:3000", "User-Agent": "x".repeat(500) },
      body: JSON.stringify({ email: "admin@example.test", password: "whatever" }),
    });
    expect(login.mock.calls[0]?.[3]).toEqual({ userAgent: "x".repeat(200) });
  });
});

describe("activity log", () => {
  it("passes validated filters through", async () => {
    const listAudit = vi.fn<OperationsRouterDependencies["listAudit"]>(async () => ({ items: [], total: 0 }));
    const response = await app({}, { listAudit }).request("/audit?entityType=inquiry&entityId=5a3c2a3e-8a0b-4d8e-9a43-1c7c5b5f9a10&pageSize=10", { headers });
    expect(response.status).toBe(200);
    expect(listAudit).toHaveBeenCalledWith(expect.objectContaining({ entityType: "inquiry", entityId: "5a3c2a3e-8a0b-4d8e-9a43-1c7c5b5f9a10", page: 1, pageSize: 10 }));
  });

  it("rejects unknown entity types and malformed IDs", async () => {
    const listAudit = vi.fn<OperationsRouterDependencies["listAudit"]>();
    expect((await app({}, { listAudit }).request("/audit?entityType=passwords", { headers })).status).toBe(400);
    expect((await app({}, { listAudit }).request("/audit?entityId=1%27%20or%201%3D1", { headers })).status).toBe(400);
    expect(listAudit).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    expect((await app().request("/audit")).status).toBe(401);
  });
});

describe("site settings", () => {
  it("normalises the notification email and audits the change", async () => {
    const updateSettings = vi.fn<OperationsRouterDependencies["updateSettings"]>(async (patch) => ({ ...settings, ...patch }));
    const response = await app({}, { updateSettings }).request("/settings", { method: "PATCH", headers, body: JSON.stringify({ inquiryNotificationEmail: " Team@Example.COM " }) });
    expect(response.status).toBe(200);
    expect(updateSettings).toHaveBeenCalledWith({ inquiryNotificationEmail: "team@example.com" }, expect.objectContaining({ actorId: actor.id }));
  });

  it("only accepts operational settings", async () => {
    const updateSettings = vi.fn<OperationsRouterDependencies["updateSettings"]>();
    const router = app({}, { updateSettings });
    for (const body of [{}, { responseTimeWording: "Within 5 minutes" }, { inquiryNotificationEmail: "not-an-email" }]) {
      expect((await router.request("/settings", { method: "PATCH", headers, body: JSON.stringify(body) })).status).toBe(400);
    }
    expect(updateSettings).not.toHaveBeenCalled();
  });

  it("allows clearing the inbox, leaving only the deployment inbox", async () => {
    const updateSettings = vi.fn<OperationsRouterDependencies["updateSettings"]>(async (patch) => ({ ...settings, ...patch }));
    await app({}, { updateSettings }).request("/settings", { method: "PATCH", headers, body: JSON.stringify({ inquiryNotificationEmail: null }) });
    expect(updateSettings.mock.calls[0]?.[0]).toEqual({ inquiryNotificationEmail: null });
    expect(notificationRecipients({ inquiryNotificationEmail: null }, "inquiries@example.com")).toEqual(["inquiries@example.com"]);
    expect(notificationRecipients({ inquiryNotificationEmail: "team@example.com" }, "inquiries@example.com")).toEqual(["team@example.com", "inquiries@example.com"]);
    expect(notificationRecipients({ inquiryNotificationEmail: "Inquiries@Example.com" }, "inquiries@example.com")).toEqual(["Inquiries@Example.com"]);
  });
});

describe("password policy", () => {
  it("applies one length rule everywhere", () => {
    expect(passwordPolicyError("x".repeat(11))).not.toBeNull();
    expect(passwordPolicyError("x".repeat(12))).toBeNull();
    expect(passwordPolicyError("x".repeat(201))).not.toBeNull();
  });
});
