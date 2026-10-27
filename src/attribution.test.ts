import { describe, expect, it } from "vitest";
import { describeAttribution, normalizeAttributionValue, normalizeLandingPath } from "./attribution.js";
import { createV1Router, type InquiryRouterDependencies, type ParsedInquiry } from "./routes/v1/index.js";

const contactInquiry = {
  name: "Mary Example",
  phone: "+234 801 234 5678",
  inquiryType: "contact",
  topic: "General question",
  message: "Please contact me about cleaning my sofa.",
};

function inquiryRouter() {
  const saved: ParsedInquiry[] = [];
  const dependencies: InquiryRouterDependencies = {
    notificationRecipient: "inbox@example.test",
    async saveInquiry(input) {
      saved.push(input);
      return { id: "3c2d57bc-11af-4c75-8b81-03a676cc1f55", reference: "MG-20261027-A1B2C3", outbox: [] };
    },
    async enqueueNotification() {},
    onNotificationQueueFailure() {},
  };
  return { router: createV1Router(dependencies), saved };
}

async function submit(router: ReturnType<typeof createV1Router>, body: Record<string, unknown>, key = "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa91") {
  return router.request("/inquiries", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Idempotency-Key": key },
    body: JSON.stringify(body),
  });
}

describe("attribution normalisation", () => {
  it("stores lowercase tokens so reports group cleanly", () => {
    expect(normalizeAttributionValue("Instagram")).toBe("instagram");
    expect(normalizeAttributionValue("  Spring Reset 2026 ")).toBe("spring-reset-2026");
    expect(normalizeAttributionValue("post_42.reel")).toBe("post_42.reel");
  });

  it("drops markup, empty, non-string, and oversized values", () => {
    expect(normalizeAttributionValue("<script>alert(1)</script>")).toBeUndefined();
    expect(normalizeAttributionValue("")).toBeUndefined();
    expect(normalizeAttributionValue("-leading-dash")).toBeUndefined();
    expect(normalizeAttributionValue({ source: "x" })).toBeUndefined();
    expect(normalizeAttributionValue(42)).toBeUndefined();
    expect(normalizeAttributionValue("a".repeat(500))).toHaveLength(120);
  });

  it("keeps landing paths same-site and strips query strings", () => {
    expect(normalizeLandingPath("/blog/deep-clean?utm_source=instagram#top")).toBe("/blog/deep-clean");
    expect(normalizeLandingPath("/")).toBe("/");
    for (const value of ["//evil.example/path", "https://evil.example", "javascript:alert(1)", "/a path", `/${"a".repeat(200)}`, "blog"]) {
      expect(normalizeLandingPath(value)).toBeUndefined();
    }
  });

  it("summarises attribution for the team's alert", () => {
    expect(describeAttribution({ utmSource: "instagram", utmMedium: "social", utmCampaign: "spring-reset", landingPath: "/blog/deep-clean" }))
      .toBe("instagram / social / spring-reset (landed on /blog/deep-clean)");
    expect(describeAttribution({})).toBe("Direct or unknown");
    expect(describeAttribution({ landingPath: "/services" })).toBe("Direct or unknown (landed on /services)");
  });
});

describe("inquiry attribution contract", () => {
  it("stores normalised attribution with the enquiry", async () => {
    const { router, saved } = inquiryRouter();
    const response = await submit(router, { ...contactInquiry, utmSource: "Instagram", utmMedium: "Social", utmCampaign: "Spring Reset", landingPath: "/blog/deep-clean?x=1" });
    expect(response.status).toBe(201);
    expect(saved[0]).toMatchObject({ utmSource: "instagram", utmMedium: "social", utmCampaign: "spring-reset", landingPath: "/blog/deep-clean" });
  });

  it("still saves the enquiry when attribution is malformed", async () => {
    const { router, saved } = inquiryRouter();
    const response = await submit(router, { ...contactInquiry, utmSource: "<img src=x>", utmCampaign: ["array"], landingPath: "https://evil.example" }, "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa92");
    expect(response.status).toBe(201);
    expect(saved[0]?.utmSource).toBeUndefined();
    expect(saved[0]?.utmCampaign).toBeUndefined();
    expect(saved[0]?.landingPath).toBeUndefined();
  });

  it("still rejects unknown fields", async () => {
    const { router } = inquiryRouter();
    const response = await submit(router, { ...contactInquiry, utm_source: "instagram" }, "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa93");
    expect(response.status).toBe(400);
  });
});
