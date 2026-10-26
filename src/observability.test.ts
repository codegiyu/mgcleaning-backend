import { Writable } from "node:stream";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { isUniqueViolation } from "./db/errors.js";
import { createLogger } from "./logger.js";
import { requestContext, type RequestContextVariables } from "./request-context.js";
import { clientIpFromForwardedFor } from "./security/inquiry-abuse.js";

function captureLogger() {
  const lines: string[] = [];
  const destination = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(String(chunk));
      callback();
    },
  });
  return { logger: createLogger({ destination, level: "info" }), lines };
}

describe("structured logging", () => {
  it("redacts contact details and credentials", () => {
    const { logger, lines } = captureLogger();
    logger.info(
      {
        name: "Mary Example",
        phone: "+234 801 234 5678",
        email: "mary@example.test",
        input: { password: "secret-value", email: "x@example.test" },
        inquiryId: "abc",
      },
      "inquiry received",
    );
    const output = lines.join("");
    expect(output).not.toContain("Mary Example");
    expect(output).not.toContain("801 234");
    expect(output).not.toContain("mary@example.test");
    expect(output).not.toContain("x@example.test");
    expect(output).not.toContain("secret-value");
    expect(output).toContain('"inquiryId":"abc"');
  });

  it("issues a request ID, echoes a well-formed one, and replaces a malformed one", async () => {
    const { logger } = captureLogger();
    const app = new Hono<{ Variables: RequestContextVariables }>();
    app.use("*", requestContext(logger));
    app.get("/", (context) => context.text(context.get("requestId")));

    const issued = await app.request("/");
    expect(issued.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await app.request("/", { headers: { "X-Request-Id": "edge-req-12345678" } });
    expect(echoed.headers.get("X-Request-Id")).toBe("edge-req-12345678");
    expect(await echoed.text()).toBe("edge-req-12345678");

    const replaced = await app.request("/", { headers: { "X-Request-Id": "not a valid id!" } });
    expect(replaced.headers.get("X-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("client IP resolution", () => {
  it("uses the address appended by the trusted proxy, not a client-supplied one", () => {
    expect(clientIpFromForwardedFor("6.6.6.6, 198.51.100.7", 1)).toBe("198.51.100.7");
    expect(clientIpFromForwardedFor("6.6.6.6, 198.51.100.7, 10.0.0.2", 2)).toBe("198.51.100.7");
  });

  it("ignores the header when no proxies are trusted or the chain is too short", () => {
    expect(clientIpFromForwardedFor("6.6.6.6", 0)).toBeNull();
    expect(clientIpFromForwardedFor("198.51.100.7", 2)).toBeNull();
    expect(clientIpFromForwardedFor(undefined, 1)).toBeNull();
  });
});

describe("database errors", () => {
  it("recognises only SQLSTATE 23505 on the named constraint", () => {
    const wrapped = { cause: { code: "23505", constraint_name: "blog_posts_slug_unique" } };
    expect(isUniqueViolation(wrapped, "blog_posts_slug_unique")).toBe(true);
    expect(isUniqueViolation(wrapped, "other_unique")).toBe(false);
    expect(isUniqueViolation({ cause: { code: "40001" } })).toBe(false);
    expect(isUniqueViolation(new Error("boom"))).toBe(false);
  });
});
