import { describe, expect, it } from "vitest";
import { parseBootstrapEmails } from "../auth/bootstrap-emails.js";

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
