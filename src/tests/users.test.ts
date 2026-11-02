import { describe, expect, it, vi } from "vitest";
import { loginLimits } from "../auth/login-rate-limit.js";
import { passwordPolicyError } from "../auth/password-policy.js";
import { verifyPassword } from "../auth/password.js";
import { generateTemporaryPassword } from "../auth/temporary-password.js";
import { createAdminRouter, type AdminRouterDependencies } from "../routes/v1/admin.js";
import { createOperationsRouter, type OperationsRouterDependencies } from "../routes/v1/operations.js";
import { createUsersRouter, type AdminUserView, type UsersRouterDependencies } from "../routes/v1/users.js";

const token = "a-session-token-used-only-in-this-test";
const ownerId = "b48d4f5b-37e4-4f3b-bd0e-2ce9712dd4a5";
const staffId = "6a1f2e3d-4c5b-4a69-8877-665544332211";
const headers = { Cookie: `mg_admin_session=${token}`, Origin: "http://localhost:3000", "Content-Type": "application/json" };

const staffUser: AdminUserView = {
  id: staffId,
  email: "staff@example.test",
  role: "staff",
  mustChangePassword: true,
  deactivatedAt: null,
  passwordChangedAt: null,
  createdAt: new Date("2026-11-01T09:00:00.000Z"),
};

type Actor = { role: "owner" | "staff"; mustChangePassword?: boolean };

function app(actor: Actor, users: Partial<UsersRouterDependencies> = {}, operations: Partial<OperationsRouterDependencies> = {}) {
  const usersDependencies: UsersRouterDependencies = {
    async listUsers() { return [staffUser]; },
    async createUser(input) { return { kind: "created", user: { ...staffUser, email: input.email, role: input.role } }; },
    async updateUser() { return { kind: "updated", user: staffUser }; },
    async resetPassword() { return { kind: "reset", user: staffUser }; },
    ...users,
  };
  const operationsDependencies: OperationsRouterDependencies = {
    async listAudit() { return { items: [], total: 0 }; },
    async getSettings() { return { inquiryNotificationEmail: null, notificationRecipients: ["inbox@example.test"], defaultAuthorName: null, updatedAt: null }; },
    async updateSettings() { return { inquiryNotificationEmail: "new@example.test", notificationRecipients: ["new@example.test", "inbox@example.test"], defaultAuthorName: null, updatedAt: null }; },
    ...operations,
  };
  const session = { id: actor.role === "owner" ? ownerId : staffId, email: "someone@example.test", sessionId: "c0ffee00-1d2e-4f3a-8b9c-0d1e2f3a4b5c", role: actor.role, mustChangePassword: actor.mustChangePassword ?? false };
  const adminDependencies = { async resolveSession(value: string) { return value === token ? session : null; } } as unknown as AdminRouterDependencies; // Only routing is exercised.
  return createAdminRouter(adminDependencies, undefined, undefined, createOperationsRouter(operationsDependencies), undefined, createUsersRouter(usersDependencies));
}

describe("account management is for owners", () => {
  it.each([
    ["GET", "/users", undefined],
    ["POST", "/users", { email: "new@example.test" }],
    ["PATCH", `/users/${ownerId}`, { role: "staff" }],
    ["POST", `/users/${ownerId}/reset-password`, undefined],
    ["PATCH", "/settings", { defaultAuthorName: "M&G Team" }],
  ])("refuses staff: %s %s", async (method, path, body) => {
    const response = await app({ role: "staff" }).request(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status).toBe(403);
  });

  it("still lets staff read the settings", async () => {
    expect((await app({ role: "staff" }).request("/settings", { headers })).status).toBe(200);
  });
});

describe("creating and resetting accounts", () => {
  it("creates a staff account with a one-time password that meets the policy", async () => {
    const createUser = vi.fn<UsersRouterDependencies["createUser"]>(async (input) => ({ kind: "created", user: { ...staffUser, email: input.email } }));
    const response = await app({ role: "owner" }, { createUser }).request("/users", { method: "POST", headers, body: JSON.stringify({ email: " New.Staff@Example.test " }) });
    expect(response.status).toBe(201);
    const { data } = await response.json();
    expect(passwordPolicyError(data.temporaryPassword)).toBeNull();
    const [input] = createUser.mock.calls[0];
    expect(input).toMatchObject({ email: "new.staff@example.test", role: "staff" });
    expect(input.passwordHash).not.toContain(data.temporaryPassword);
    await expect(verifyPassword(data.temporaryPassword, input.passwordHash)).resolves.toBe(true);
  });

  it("reports a duplicate email as 409", async () => {
    const response = await app({ role: "owner" }, { async createUser() { return { kind: "duplicate" }; } }).request("/users", { method: "POST", headers, body: JSON.stringify({ email: "staff@example.test" }) });
    expect(response.status).toBe(409);
  });

  it("returns a fresh temporary password on reset", async () => {
    const response = await app({ role: "owner" }).request(`/users/${staffId}/reset-password`, { method: "POST", headers });
    expect(response.status).toBe(200);
    expect(passwordPolicyError((await response.json()).data.temporaryPassword)).toBeNull();
  });
});

describe("changing accounts", () => {
  it("never lets an owner change or reset their own account", async () => {
    const updateUser = vi.fn<UsersRouterDependencies["updateUser"]>();
    const router = app({ role: "owner" }, { updateUser });
    expect((await router.request(`/users/${ownerId}`, { method: "PATCH", headers, body: JSON.stringify({ active: false }) })).status).toBe(400);
    expect((await router.request(`/users/${ownerId}/reset-password`, { method: "POST", headers })).status).toBe(400);
    expect(updateUser).not.toHaveBeenCalled();
  });

  it("refuses to remove the last active owner", async () => {
    const response = await app({ role: "owner" }, { async updateUser() { return { kind: "last-owner" }; } }).request(`/users/${staffId}`, { method: "PATCH", headers, body: JSON.stringify({ role: "staff" }) });
    expect(response.status).toBe(409);
  });

  it("refuses other origins and empty changes", async () => {
    const router = app({ role: "owner" });
    expect((await router.request(`/users/${staffId}`, { method: "PATCH", headers: { ...headers, Origin: "https://attacker.example" }, body: JSON.stringify({ active: false }) })).status).toBe(403);
    expect((await router.request(`/users/${staffId}`, { method: "PATCH", headers, body: JSON.stringify({}) })).status).toBe(400);
  });
});

describe("a new or reset account must choose its own password first", () => {
  it("blocks everything except changing the password and signing out", async () => {
    const router = app({ role: "staff", mustChangePassword: true });
    expect((await router.request("/settings", { headers })).status).toBe(403);
    expect((await router.request("/auth/session", { headers })).status).toBe(200);
  });
});

describe("sign-in limits", () => {
  it("counts per email-and-address, per address, and per email", () => {
    const limits = loginLimits(" Owner@Example.test ", "ip-hash-a");
    expect(limits.map((limit) => [limit.limit, limit.ttlSeconds])).toEqual([[5, 900], [20, 900], [50, 3600]]);
    const sameEmailOtherAddress = loginLimits("owner@example.test", "ip-hash-b");
    // Guessing from address A never touches address B's counter for the same account.
    expect(sameEmailOtherAddress[0].key).not.toBe(limits[0].key);
    expect(sameEmailOtherAddress[2].key).toBe(limits[2].key);
    expect(JSON.stringify(limits)).not.toContain("owner@example.test");
  });
});

describe("temporary passwords", () => {
  it("are long, grouped, and avoid look-alike characters", () => {
    const passwords = new Set(Array.from({ length: 50 }, generateTemporaryPassword));
    expect(passwords.size).toBe(50);
    for (const password of passwords) expect(password).toMatch(/^[a-km-np-zA-HJ-NP-Z2-9]{4}(-[a-km-np-zA-HJ-NP-Z2-9]{4}){3}$/);
  });
});

describe("hidden accounts", () => {
  const hiddenId = "0f1e2d3c-4b5a-4968-8776-655443322110";
  const hiddenUser: AdminUserView = { ...staffUser, id: hiddenId, email: "codegiyu@gmail.com", role: "owner" };
  const withHidden = { async listUsers() { return [staffUser, hiddenUser]; } };

  it("leaves the hidden account out of the list for other admins", async () => {
    const response = await app({ role: "owner" }, withHidden).request("/users", { headers });
    const { data } = await response.json();
    expect(data.map((user: AdminUserView) => user.email)).toEqual(["staff@example.test"]);
  });

  it("shows it to the hidden admin themselves, whatever the letter case", async () => {
    const session = { id: hiddenId, email: "CodeGiyu@Gmail.com", sessionId: "c0ffee00-1d2e-4f3a-8b9c-0d1e2f3a4b5c", role: "owner", mustChangePassword: false };
    const admin = createAdminRouter({ async resolveSession(value: string) { return value === token ? session : null; } } as unknown as AdminRouterDependencies, undefined, undefined, undefined, undefined, createUsersRouter({ ...(await usersDefaults()), ...withHidden }));
    const { data } = await (await admin.request("/users", { headers })).json();
    expect(data.map((user: AdminUserView) => user.email)).toContain("codegiyu@gmail.com");
  });

  it.each([
    ["PATCH", { active: false }, "/users/" ],
    ["POST", undefined, "/users/"],
  ])("answers %s on it with 404 for other admins", async (method, body, base) => {
    const path = method === "PATCH" ? `${base}${hiddenId}` : `${base}${hiddenId}/reset-password`;
    const updateUser = vi.fn<UsersRouterDependencies["updateUser"]>();
    const resetPassword = vi.fn<UsersRouterDependencies["resetPassword"]>();
    const response = await app({ role: "owner" }, { ...withHidden, updateUser, resetPassword }).request(path, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    expect(response.status).toBe(404);
    expect(updateUser).not.toHaveBeenCalled();
    expect(resetPassword).not.toHaveBeenCalled();
  });

  it("does not reveal it through the create-account check", async () => {
    const createUser = vi.fn<UsersRouterDependencies["createUser"]>();
    const response = await app({ role: "owner" }, { ...withHidden, createUser }).request("/users", { method: "POST", headers, body: JSON.stringify({ email: "CODEGIYU@gmail.com" }) });
    expect(response.status).toBe(409);
    expect(createUser).not.toHaveBeenCalled();
  });

  it("replaces its email in the activity log for other admins only", async () => {
    const event = { id: "e1", action: "settings.update", entityType: "site_settings", entityId: "1", actorEmail: "codegiyu@gmail.com", metadata: {}, requestId: null, createdAt: new Date("2026-11-01T09:00:00.000Z") };
    const listAudit = async () => ({ items: [event, { ...event, id: "e2", actorEmail: "staff@example.test" }], total: 2 });
    const { data } = await (await app({ role: "staff" }, {}, { listAudit }).request("/audit", { headers })).json();
    expect(data.items.map((item: { actorEmail: string }) => item.actorEmail)).toEqual(["Site administrator", "staff@example.test"]);
  });
});

async function usersDefaults(): Promise<UsersRouterDependencies> {
  return {
    async listUsers() { return [staffUser]; },
    async createUser(input) { return { kind: "created", user: { ...staffUser, email: input.email, role: input.role } }; },
    async updateUser() { return { kind: "updated", user: staffUser }; },
    async resetPassword() { return { kind: "reset", user: staffUser }; },
  };
}
