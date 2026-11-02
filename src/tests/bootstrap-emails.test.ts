import { describe, expect, it } from "vitest";
import { parseBootstrapEmails } from "../auth/bootstrap-emails.js";
import { bootstrapAdmins } from "../auth/bootstrap-admins.js";

describe("parseBootstrapEmails", () => {
  it("accepts one address", () => {
    expect(parseBootstrapEmails("Owner@Example.test")).toEqual(["owner@example.test"]);
  });

  it("splits on commas, trims, lowercases and drops blanks and repeats", () => {
    expect(parseBootstrapEmails(" a@x.test, B@x.test ,,a@x.test,\n")).toEqual(["a@x.test", "b@x.test"]);
  });

  it("returns nothing when unset or blank", () => {
    expect(parseBootstrapEmails(undefined)).toEqual([]);
    expect(parseBootstrapEmails("  ,  ")).toEqual([]);
  });

  it("names the entry that is not an email address", () => {
    expect(() => parseBootstrapEmails("a@x.test, not-an-email")).toThrow('"not-an-email"');
  });
});

describe("bootstrapAdmins input checks", () => {
  it("needs both an email list and a password", async () => {
    await expect(bootstrapAdmins(undefined, "a-long-enough-password")).rejects.toThrow(/BOOTSTRAP_ADMIN_EMAIL/);
    await expect(bootstrapAdmins("owner@example.test", undefined)).rejects.toThrow(/BOOTSTRAP_ADMIN_PASSWORD/);
  });

  it("refuses a short password and a malformed address before touching the database", async () => {
    await expect(bootstrapAdmins("owner@example.test", "short")).rejects.toThrow(/Initial admin password/);
    await expect(bootstrapAdmins("not-an-email", "a-long-enough-password")).rejects.toThrow(/invalid email/);
  });
});
