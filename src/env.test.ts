import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";

/** A complete, valid production configuration; each test breaks one thing. */
const production = {
  NODE_ENV: "production",
  FRONTEND_ORIGIN: "https://mgcleaning.example.ng",
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
    ["FRONTEND_ORIGIN", { FRONTEND_ORIGIN: "http://mgcleaning.example.ng" }],
    ["FRONTEND_ORIGIN", { FRONTEND_ORIGIN: undefined }],
    ["RESEND_API_KEY", { RESEND_API_KEY: undefined }],
    ["REVALIDATE_SECRET", { REVALIDATE_SECRET: undefined }],
  ])("refuses to start in production without a proper %s", (key, change) => {
    expect(problems({ ...production, ...change })).toContain(key);
  });

  it("does not need a Resend key when sending through SMTP", () => {
    expect(problems({ ...production, EMAIL_PROVIDER: "smtp", RESEND_API_KEY: undefined, SMTP_HOST: "smtp.mgcleaning.ng" })).toEqual([]);
  });
});
