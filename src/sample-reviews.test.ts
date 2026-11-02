import { describe, expect, it } from "vitest";
import { parseEnv } from "./env.js";
import { reviewInputSchema, watToday } from "./reviews/policy.js";
import { SAMPLE_CONTEXT_PREFIX, sampleReviewRows, sampleReviews } from "./reviews/sample-reviews.js";

const now = new Date("2026-11-02T09:00:00.000Z");

describe("sample reviews", () => {
  it("each passes the same validation as a review entered in the dashboard", () => {
    for (const sample of sampleReviews) expect(reviewInputSchema.safeParse(sample).success, sample.displayName).toBe(true);
  });

  it("are all labelled as samples", () => {
    for (const sample of sampleReviews) expect(sample.context?.startsWith(SAMPLE_CONTEXT_PREFIX)).toBe(true);
  });

  it("include published reviews for the homepage and drafts for the dashboard", () => {
    const statuses = sampleReviews.map((sample) => sample.status);
    expect(statuses).toContain("published");
    expect(statuses).toContain("draft");
  });

  it("are not dated in the future", () => {
    for (const sample of sampleReviews) expect(sample.receivedOn! <= watToday(now)).toBe(true);
  });

  it("stamp consent and publication only on published rows", () => {
    for (const row of sampleReviewRows(now)) {
      const isPublished = row.status === "published";
      expect(row.consentConfirmedAt).toEqual(isPublished ? now : null);
      expect(row.publishedAt).toEqual(isPublished ? now : null);
    }
  });
});

describe("SEED_SAMPLE_REVIEWS", () => {
  it("is off unless set to true", () => {
    expect(parseEnv({}).SEED_SAMPLE_REVIEWS).toBe(false);
    expect(parseEnv({ SEED_SAMPLE_REVIEWS: "true" }).SEED_SAMPLE_REVIEWS).toBe(true);
  });
});
