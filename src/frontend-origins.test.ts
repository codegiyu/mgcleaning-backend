import { beforeAll, describe, expect, it, vi } from "vitest";

const primary = "https://mgcleaning.example.ng";
const local = "http://localhost:3000";
const stranger = "https://elsewhere.example.ng";

// The env module is parsed on import, so set the list before loading the app.
let app: (typeof import("./app.js"))["app"];
beforeAll(async () => {
  vi.stubEnv("FRONTEND_ORIGINS", `${primary},${local}`);
  vi.resetModules();
  ({ app } = await import("./app.js"));
});

function preflight(origin: string) {
  return app.request("/api/v1/inquiries", {
    method: "OPTIONS",
    headers: { Origin: origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type,idempotency-key" },
  });
}

/** Login checks the Origin before reading the body, so an empty body shows which side of the check a request lands on. */
function login(origin: string) {
  return app.request("/api/v1/admin/auth/login", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}" });
}

describe("several FRONTEND_ORIGINS", () => {
  it.each([primary, local])("lets %s call the API from a browser", async (origin) => {
    const response = await preflight(origin);
    expect(response.headers.get("access-control-allow-origin")).toBe(origin);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("vary")).toContain("Origin");
  });

  it("gives an unlisted website no CORS permission", async () => {
    expect((await preflight(stranger)).headers.get("access-control-allow-origin")).toBeNull();
  });

  it.each([primary, local])("accepts admin writes from %s", async (origin) => {
    expect((await login(origin)).status).toBe(400);
  });

  it("refuses admin writes from an unlisted website", async () => {
    expect((await login(stranger)).status).toBe(403);
  });
});
