import { describe, expect, it } from "vitest";
import { app } from "./app.js";
import {
  createV1Router,
  type CreateInquiryInput,
  type InquiryRouterDependencies,
  type SavedInquiry,
} from "./routes/v1/index.js";
import type { OutboundEmailJob } from "./queue/email.queue.js";

const validInquiry: CreateInquiryInput = {
  name: "Mary Example",
  phone: "+234 801 234 5678",
  inquiryType: "contact",
  topic: "General question",
  serviceInterest: "Upholstery cleaning",
  message: "Please contact me about cleaning my sofa.",
};

function makeInquiryRouter(
  overrides: Partial<InquiryRouterDependencies> = {},
) {
  const savedInputs: CreateInquiryInput[] = [];
  const queuedEmails: OutboundEmailJob[] = [];
  const queueFailures: string[] = [];
  const dependencies: InquiryRouterDependencies = {
    notificationRecipient: "inbox@example.test",
    async saveInquiry(input): Promise<SavedInquiry> {
      savedInputs.push(input);
      return {
        id: "3c2d57bc-11af-4c75-8b81-03a676cc1f55",
        reference: "MG-20260928-A1B2C3",
        outbox: [
          { id: "internal-email-outbox-id", kind: "internal" },
          ...(input.email ? [{ id: "customer-email-outbox-id", kind: "customer" as const }] : []),
        ],
      };
    },
    async enqueueNotification(job) {
      queuedEmails.push(job);
    },
    onNotificationQueueFailure(inquiryId) {
      queueFailures.push(inquiryId);
    },
    ...overrides,
  };

  return {
    router: createV1Router(dependencies),
    savedInputs,
    queuedEmails,
    queueFailures,
  };
}

describe("GET /api/v1/health", () => {
  it("returns the typed health envelope", async () => {
    const response = await app.request("/api/v1/health");
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      message: "API is healthy.",
      responseCode: 200,
      data: {
        service: "mgcleaning-backend",
        status: "ok",
      },
    });
  });
});

describe("POST /api/v1/inquiries", () => {
  it("validates, saves, and queues a notification for an inquiry", async () => {
    const { router, savedInputs, queuedEmails } = makeInquiryRouter();
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa01" },
      body: JSON.stringify(validInquiry),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      success: true,
      message: "Your inquiry has been received.",
      responseCode: 201,
      data: {
        inquiryId: "3c2d57bc-11af-4c75-8b81-03a676cc1f55",
        reference: "MG-20260928-A1B2C3",
        notificationQueued: true,
        internalNotificationQueued: true,
        customerEmailQueued: null,
      },
    });
    expect(savedInputs).toEqual([validInquiry]);
    expect(queuedEmails).toHaveLength(1);
    expect(queuedEmails[0]).toEqual({ outboxId: "internal-email-outbox-id" });
  });

  it("rejects invalid input without saving or queueing", async () => {
    const { router, savedInputs, queuedEmails } = makeInquiryRouter();
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa02" },
      body: JSON.stringify({ ...validInquiry, name: "  ", message: "short" }),
    });
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      message: "Please check the form details and try again.",
      responseCode: 400,
    });
    expect(savedInputs).toHaveLength(0);
    expect(queuedEmails).toHaveLength(0);
  });

  it("accepts a booking request with scheduling details", async () => {
    const { router, savedInputs, queuedEmails } = makeInquiryRouter();
    const booking = {
      name: "Mary Example",
      phone: "+234 801 234 5678",
      email: "mary@example.test",
      inquiryType: "booking",
      serviceInterest: "Upholstery cleaning",
      preferredDate: "2026-10-04",
      preferredTime: "Morning (8am–12pm)",
      preferredContactMethod: "whatsapp",
      location: "Lekki Phase 1, Lagos",
      spaceType: "Home",
      message: "Two sofas need a deep clean before guests arrive.",
    };
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa03" },
      body: JSON.stringify(booking),
    });

    expect(response.status).toBe(201);
    expect(savedInputs[0]).toEqual(booking);
    expect(queuedEmails).toHaveLength(2);
    expect(queuedEmails).toEqual([
      { outboxId: "internal-email-outbox-id" },
      { outboxId: "customer-email-outbox-id" },
    ]);
  });

  it("keeps the saved inquiry successful when notification queueing fails", async () => {
    const { router, savedInputs, queueFailures } = makeInquiryRouter({
      async enqueueNotification() {
        throw new Error("Redis unavailable");
      },
    });
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa04" },
      body: JSON.stringify(validInquiry),
    });
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(savedInputs).toEqual([validInquiry]);
    expect(body.data.notificationQueued).toBe(false);
    expect(queueFailures).toEqual(["3c2d57bc-11af-4c75-8b81-03a676cc1f55"]);
  });

  it("requires an idempotency key", async () => {
    const { router, savedInputs } = makeInquiryRouter();
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validInquiry),
    });

    expect(response.status).toBe(400);
    expect(savedInputs).toHaveLength(0);
  });

  it("rejects a filled honeypot without saving", async () => {
    const { router, savedInputs, queuedEmails } = makeInquiryRouter();
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa05" },
      body: JSON.stringify({ ...validInquiry, companyWebsite: "https://bot.example" }),
    });

    expect(response.status).toBe(400);
    expect(savedInputs).toHaveLength(0);
    expect(queuedEmails).toHaveLength(0);
  });

  it("returns a retry hint when the rate limit is exceeded", async () => {
    const { router, savedInputs } = makeInquiryRouter({
      async allowRequest() {
        return { allowed: false, retryAfterSeconds: 42, reason: "ip-window" };
      },
    });
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa06" },
      body: JSON.stringify(validInquiry),
    });
    const body = await response.json();

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(body.message).toBe("Please wait before sending another request.");
    expect(savedInputs).toHaveLength(0);
  });

  it("rejects an invalid calendar date", async () => {
    const { router, savedInputs } = makeInquiryRouter();
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa07" },
      body: JSON.stringify({
        ...validInquiry,
        inquiryType: "booking",
        email: "mary@example.test",
        preferredContactMethod: "phone",
        serviceInterest: "Upholstery cleaning",
        preferredDate: "2026-02-30",
        preferredTime: "Morning (8am–12pm)",
        location: "Lekki Phase 1, Lagos",
        spaceType: "Home",
      }),
    });

    expect(response.status).toBe(400);
    expect(savedInputs).toHaveLength(0);
  });

  it("rejects high-confidence spam before persistence", async () => {
    const { router, savedInputs, queuedEmails } = makeInquiryRouter();
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa08" },
      body: JSON.stringify({
        ...validInquiry,
        message: "https://a.example https://b.example https://c.example <script>buy now</script>",
      }),
    });

    expect(response.status).toBe(400);
    expect(savedInputs).toHaveLength(0);
    expect(queuedEmails).toHaveLength(0);
  });

  it("rejects a duplicate fingerprint before persistence", async () => {
    const { router, savedInputs } = makeInquiryRouter({
      async claimFingerprint() {
        return { claimed: false, owner: false, key: "fingerprint", value: "existing" };
      },
    });
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa09" },
      body: JSON.stringify(validInquiry),
    });

    expect(response.status).toBe(429);
    expect(savedInputs).toHaveLength(0);
  });

  it("rejects an oversized request before parsing", async () => {
    const { router, savedInputs } = makeInquiryRouter();
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa10" },
      body: JSON.stringify({ ...validInquiry, padding: "x".repeat(40_000) }),
    });

    expect(response.status).toBe(413);
    expect(savedInputs).toHaveLength(0);
  });

  it("rejects non-JSON request bodies", async () => {
    const { router, savedInputs } = makeInquiryRouter();
    const response = await router.request("/inquiries", {
      method: "POST",
      headers: { "Content-Type": "text/plain", "Idempotency-Key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa11" },
      body: JSON.stringify(validInquiry),
    });

    expect(response.status).toBe(415);
    expect(savedInputs).toHaveLength(0);
  });
});
