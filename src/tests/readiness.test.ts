import { describe, expect, it } from "vitest";
import { app } from "../app.js";
import { createReadinessRouter } from "../routes/v1/readiness.js";

const ok = async () => {};
const down = async () => { throw new Error("connection refused"); };

describe("GET /health/ready", () => {
  it("is ready when the database and Redis answer", async () => {
    const response = await createReadinessRouter({ checkDatabase: ok, checkRedis: ok }).request("/");
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual({ status: "ready", checks: { database: "ok", redis: "ok" } });
  });

  it.each([
    ["database", { checkDatabase: down, checkRedis: ok }],
    ["redis", { checkDatabase: ok, checkRedis: down }],
  ])("answers 503 naming the %s when it is down, without the error detail", async (name, dependencies) => {
    const response = await createReadinessRouter(dependencies).request("/");
    const body = await response.json();
    expect(response.status).toBe(503);
    expect(body.data.checks[name]).toBe("failed");
    expect(JSON.stringify(body)).not.toContain("connection refused");
  });

  it("is mounted next to the liveness check", async () => {
    expect((await app.request("/api/v1/health")).status).toBe(200);
  });
});
