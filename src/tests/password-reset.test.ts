import { describe, expect, it, vi } from "vitest";
import { digestResetToken, newResetToken, PASSWORD_RESET_MINUTES, passwordResetEmail, passwordResetLink } from "../auth/password-reset.js";
import { createAdminRouter, type AdminRouterDependencies } from "../routes/v1/admin.js";
import { createPasswordResetRouter, RESET_REQUESTED_MESSAGE, type PasswordResetDependencies } from "../routes/v1/password-reset.js";

const origin = "http://localhost:3000";
const json = { Origin: origin, "Content-Type": "application/json" };
const token = newResetToken().token;

function resetApp(overrides: Partial<PasswordResetDependencies> = {}) {
  const dependencies: PasswordResetDependencies = {
    allowRequest: vi.fn(async () => true),
    allowConfirm: vi.fn(async () => true),
    issue: vi.fn(async () => ({ outboxId: "0f8b7a6e-5d4c-4b3a-9f8e-7d6c5b4a3f2e" })),
    confirm: vi.fn(async () => ({ kind: "reset" as const, revokedSessions: 2 })),
    enqueue: vi.fn(async () => undefined),
    ...overrides,
  };
  return { app: createPasswordResetRouter(dependencies), dependencies };
}

const post = (app: ReturnType<typeof resetApp>["app"], path: string, body: unknown, headers: Record<string, string> = json) =>
  app.request(path, { method: "POST", headers, body: JSON.stringify(body) });

describe("reset tokens and email", () => {
  it("makes 43-character URL-safe tokens and stores only their hash", () => {
    const { token: fresh, tokenHash } = newResetToken();
    expect(fresh).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenHash).toBe(digestResetToken(fresh));
    expect(tokenHash).not.toContain(fresh);
  });

  it("puts the token in the link's fragment, which browsers never send to a server", () => {
    expect(passwordResetLink("https://mgcleaning.example", "abc")).toBe("https://mgcleaning.example/admin/reset-password#token=abc");
  });

  it("emails one button to the link and says how long it lasts", () => {
    const email = passwordResetEmail("https://mgcleaning.example/admin/reset-password#token=abc");
    expect(email.actions).toEqual([{ label: "Choose a new password", href: "https://mgcleaning.example/admin/reset-password#token=abc" }]);
    expect(email.message).toContain(`${PASSWORD_RESET_MINUTES} minutes`);
    expect(email.message).not.toContain("token=");
    expect(email.subject).not.toMatch(/M&G/);
  });
});

describe("POST /request", () => {
  it("answers the same for an unknown email, and only queues an email for a real account", async () => {
    const known = resetApp();
    const unknown = resetApp({ issue: vi.fn(async () => null) });
    const knownResponse = await post(known.app, "/request", { email: "Owner@Example.test" });
    const unknownResponse = await post(unknown.app, "/request", { email: "nobody@example.test" });
    expect(knownResponse.status).toBe(200);
    expect(unknownResponse.status).toBe(200);
    expect((await knownResponse.json()).message).toBe(RESET_REQUESTED_MESSAGE);
    expect((await unknownResponse.json()).message).toBe(RESET_REQUESTED_MESSAGE);
    expect(known.dependencies.issue).toHaveBeenCalledWith("owner@example.test", expect.anything());
    expect(known.dependencies.enqueue).toHaveBeenCalledWith("0f8b7a6e-5d4c-4b3a-9f8e-7d6c5b4a3f2e");
    expect(unknown.dependencies.enqueue).not.toHaveBeenCalled();
  });

  it("still answers when queueing fails, since the worker sweeps pending emails", async () => {
    const { app } = resetApp({ enqueue: vi.fn(async () => { throw new Error("redis down"); }) });
    expect((await post(app, "/request", { email: "owner@example.test" })).status).toBe(200);
  });

  it("refuses bad emails, other origins, and too many requests", async () => {
    expect((await post(resetApp().app, "/request", { email: "not-an-email" })).status).toBe(400);
    expect((await post(resetApp().app, "/request", { email: "owner@example.test" }, { ...json, Origin: "https://elsewhere.example" })).status).toBe(403);
    const limited = resetApp({ allowRequest: vi.fn(async () => false) });
    expect((await post(limited.app, "/request", { email: "owner@example.test" })).status).toBe(429);
    expect(limited.dependencies.issue).not.toHaveBeenCalled();
  });
});

describe("POST /confirm", () => {
  it("sets the new password from a valid link", async () => {
    const { app, dependencies } = resetApp();
    const response = await post(app, "/confirm", { token, newPassword: "a-brand-new-password" });
    expect(response.status).toBe(200);
    expect(dependencies.confirm).toHaveBeenCalledWith(token, "a-brand-new-password", expect.anything());
  });

  it("refuses used, expired, or malformed links with the same message", async () => {
    const invalid = await post(resetApp({ confirm: vi.fn(async () => ({ kind: "invalid" as const })) }).app, "/confirm", { token, newPassword: "a-brand-new-password" });
    const malformed = await post(resetApp().app, "/confirm", { token: "short", newPassword: "a-brand-new-password" });
    expect(invalid.status).toBe(400);
    expect(malformed.status).toBe(400);
    expect((await invalid.json()).message).toBe((await malformed.json()).message);
  });

  it("asks for a longer password, and limits attempts", async () => {
    const short = await post(resetApp().app, "/confirm", { token, newPassword: "short" });
    expect((await short.json()).message).toMatch(/between 12 and/);
    const limited = resetApp({ allowConfirm: vi.fn(async () => false) });
    expect((await post(limited.app, "/confirm", { token, newPassword: "a-brand-new-password" })).status).toBe(429);
    expect(limited.dependencies.confirm).not.toHaveBeenCalled();
  });
});

describe("the admin router", () => {
  it("lets reset requests through without a session", async () => {
    const issue = vi.fn(async () => null);
    const router = createAdminRouter(
      { async resolveSession() { return null; } } as unknown as AdminRouterDependencies, // Only the session check runs.
      undefined, undefined, undefined, undefined, undefined,
      resetApp({ issue }).app,
    );
    expect((await router.request("/auth/password-reset/request", { method: "POST", headers: json, body: JSON.stringify({ email: "owner@example.test" }) })).status).toBe(200);
    expect((await router.request("/overview")).status).toBe(401);
  });
});
