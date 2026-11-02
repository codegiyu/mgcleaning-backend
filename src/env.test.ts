import { describe, expect, it } from "vitest";
import { parseEnv, primaryFrontendOrigin } from "./env.js";

/** A complete, valid production configuration; each test breaks one thing. */
const production = {
  NODE_ENV: "production",
  FRONTEND_ORIGINS: "https://mgcleaning.example.ng",
  DATABASE_URL: "postgresql://mg:secret@postgres:5432/mgcleaning",
  REDIS_URL: "redis://redis:6379",
  EMAIL_PROVIDER: "resend",
  RESEND_API_KEY: "re_live_key",
  EMAIL_FROM: "notifications@mgcleaning.ng",
  INQUIRY_NOTIFICATION_TO: "enquiries@mgcleaning.ng",
  INQUIRY_SECURITY_SECRET: "a-random-production-secret-of-40-characters",
  R2_ACCOUNT_ID: "account",
  R2_ACCESS_KEY_ID: "key",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET_NAME: "mgcleaning",
  R2_PUBLIC_URL: "https://media.mgcleaning.ng",
  REVALIDATE_SECRET: "a-shared-revalidation-secret-of-40-chars",
};

function problems(source: Record<string, string | undefined>) {
  try {
    parseEnv(source);
    return [];
  } catch (error) {
    return (error as { issues?: { path: PropertyKey[] }[] }).issues?.map((issue) => String(issue.path[0])) ?? ["unknown"];
  }
}

describe("parseEnv", () => {
  it("accepts a complete production configuration", () => {
    expect(problems(production)).toEqual([]);
  });

  it("keeps development defaults outside production", () => {
    expect(parseEnv({}).INQUIRY_NOTIFICATION_TO).toBe("inquiries@example.com");
  });

  it.each([
    ["DATABASE_URL", { DATABASE_URL: undefined }],
    ["REDIS_URL", { REDIS_URL: "" }],
    ["INQUIRY_SECURITY_SECRET", { INQUIRY_SECURITY_SECRET: undefined }],
    ["INQUIRY_SECURITY_SECRET", { INQUIRY_SECURITY_SECRET: "short-but-sixteen!!" }],
    ["EMAIL_FROM", { EMAIL_FROM: undefined }],
    ["INQUIRY_NOTIFICATION_TO", { INQUIRY_NOTIFICATION_TO: "inbox@example.org" }],
    ["FRONTEND_ORIGINS", { FRONTEND_ORIGINS: "http://mgcleaning.example.ng" }],
    ["FRONTEND_ORIGINS", { FRONTEND_ORIGINS: undefined }],
    ["FRONTEND_ORIGINS", { FRONTEND_ORIGINS: "https://mgcleaning.example.ng,http://staging.example.ng" }],
    ["RESEND_API_KEY", { RESEND_API_KEY: undefined }],
    ["REVALIDATE_SECRET", { REVALIDATE_SECRET: undefined }],
  ])("refuses to start in production without a proper %s", (key, change) => {
    expect(problems({ ...production, ...change })).toContain(key);
  });

  it("does not need a Resend key when sending through SMTP", () => {
    expect(problems({ ...production, EMAIL_PROVIDER: "smtp", RESEND_API_KEY: undefined, SMTP_HOST: "smtp.mgcleaning.ng" })).toEqual([]);
  });

  it("hides codegiyu@gmail.com by default and reads a custom comma-separated list", () => {
    expect(parseEnv({}).HIDDEN_ADMIN_EMAILS).toEqual(["codegiyu@gmail.com"]);
    expect(parseEnv({ HIDDEN_ADMIN_EMAILS: " A@x.test , b@x.test," }).HIDDEN_ADMIN_EMAILS).toEqual(["a@x.test", "b@x.test"]);
    expect(parseEnv({ HIDDEN_ADMIN_EMAILS: "" }).HIDDEN_ADMIN_EMAILS).toEqual([]);
  });
});

describe("FRONTEND_ORIGINS", () => {
  it("reads a comma-separated list, with the first entry as the primary website", () => {
    const parsed = parseEnv({ FRONTEND_ORIGINS: " https://mgcleaning.example.ng , http://localhost:3000," });
    expect(parsed.FRONTEND_ORIGINS).toEqual(["https://mgcleaning.example.ng", "http://localhost:3000"]);
    expect(primaryFrontendOrigin(parsed)).toBe("https://mgcleaning.example.ng");
  });

  it("defaults to the local website", () => {
    expect(parseEnv({}).FRONTEND_ORIGINS).toEqual(["http://localhost:3000"]);
  });

  it("still reads the old single FRONTEND_ORIGIN when FRONTEND_ORIGINS is unset", () => {
    expect(parseEnv({ FRONTEND_ORIGIN: "https://old.example.ng" }).FRONTEND_ORIGINS).toEqual(["https://old.example.ng"]);
    expect(parseEnv({ FRONTEND_ORIGIN: "https://old.example.ng", FRONTEND_ORIGINS: "https://new.example.ng" }).FRONTEND_ORIGINS).toEqual(["https://new.example.ng"]);
  });

  it.each(["https://mgcleaning.example.ng/", "https://mgcleaning.example.ng/admin", "not a url"])("refuses %s, which is not a bare origin", (origin) => {
    expect(problems({ FRONTEND_ORIGINS: origin })).toContain("FRONTEND_ORIGINS");
  });

  it("allows local origins after the https primary in production", () => {
    expect(problems({ ...production, FRONTEND_ORIGINS: "https://mgcleaning.example.ng,http://localhost:3000,http://127.0.0.1:3100" })).toEqual([]);
  });

  it("refuses a local origin as the production primary", () => {
    expect(problems({ ...production, FRONTEND_ORIGINS: "http://localhost:3000,https://mgcleaning.example.ng" })).toContain("FRONTEND_ORIGINS");
  });
});
