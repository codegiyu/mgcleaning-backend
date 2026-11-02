import { describe, expect, it } from "vitest";
import { FORM_RESPONSE_EXPECTATION, MESSAGE_RESPONSE_EXPECTATION } from "../emails/response-expectation.js";
import { plainTextBody } from "../emails/alert-actions.js";
import { createEmailOutboxRows, createV1Router, type InquiryRouterDependencies, type ParsedInquiry } from "../routes/v1/index.js";

const inquiry = { id: "3c2d57bc-11af-4c75-8b81-03a676cc1f55", reference: "MG-20261027-A1B2C3" };

/** Parse a payload through the real route so the rows are built from validated input. */
async function parsedInquiry(body: Record<string, unknown>) {
  const saved: ParsedInquiry[] = [];
  const dependencies: InquiryRouterDependencies = {
    notificationRecipient: "inbox@example.test",
    async saveInquiry(input) {
      saved.push(input);
      return { ...inquiry, outbox: [] };
    },
    async enqueueNotification() {},
    onNotificationQueueFailure() {},
  };
  const response = await createV1Router(dependencies).request("/inquiries", {
    method: "POST",
    headers: { "content-type": "application/json", "idempotency-key": "4f01d6f0-f7f7-4e5b-a343-3bdf3d2eaa91" },
    body: JSON.stringify(body),
  });
  expect(response.status).toBe(201);
  return saved[0];
}

const contactPayload = {
  name: "Mary Example",
  phone: "+234 801 234 5678",
  email: "mary@example.test",
  inquiryType: "contact",
  topic: "General question",
  message: "Please contact me about cleaning my sofa.",
};

describe("inquiry emails", () => {
  it("quotes the shared response promises in the customer receipt", async () => {
    const rows = createEmailOutboxRows(await parsedInquiry(contactPayload), inquiry, ["inbox@example.test"]);
    const receipt = rows.find((row) => row.kind === "customer");
    expect(receipt?.message).toContain(`${FORM_RESPONSE_EXPECTATION}.`);
    expect(receipt?.message).toContain(`${MESSAGE_RESPONSE_EXPECTATION}.`);
    expect(receipt?.message).not.toMatch(/business day/i);
    // The sender name (EMAIL_FROM_NAME) carries the brand, so the subject does not repeat it.
    expect(receipt?.subject).toBe(`Request received · ${inquiry.reference}`);
  });

  it("gives the internal alert one-tap actions and replies that reach the customer", async () => {
    const rows = createEmailOutboxRows(await parsedInquiry(contactPayload), inquiry, ["inbox@example.test"], "https://mgcleaning.example");
    const alert = rows.find((row) => row.kind === "internal");
    expect(alert?.actions?.map((action) => action.label)).toEqual(["Reply on WhatsApp", "Call", "Open in dashboard"]);
    expect(alert?.replyTo).toBe("mary@example.test");
    // Buttons in HTML; the plain-text part lists the same links after the details.
    expect(alert?.message).not.toContain("wa.me");
    expect(plainTextBody(alert?.message ?? "", alert?.actions ?? [])).toContain(`Open in dashboard: https://mgcleaning.example/admin/inquiries/${inquiry.id}`);
    const receipt = rows.find((row) => row.kind === "customer");
    expect(receipt?.actions).toBeUndefined();
    expect(receipt?.replyTo).toBeUndefined();
  });

  it("sends the team alert to every inbox, with a subject naming the form", async () => {
    const rows = createEmailOutboxRows(await parsedInquiry(contactPayload), inquiry, ["team@example.test", "inquiries@example.test"]);
    const alerts = rows.filter((row) => row.kind === "internal");
    expect(alerts.map((row) => row.to)).toEqual(["team@example.test", "inquiries@example.test"]);
    expect(alerts.map((row) => row.subject)).toEqual(["Contact form submission received", "Contact form submission received"]);
    const booking = createEmailOutboxRows({ ...(await parsedInquiry(contactPayload)), inquiryType: "booking" }, inquiry, ["team@example.test"]);
    expect(booking.find((row) => row.kind === "internal")?.subject).toBe("Booking form submission received");
  });

  it("sends no receipt when the customer gave no email", async () => {
    const { email: _omitted, ...withoutEmail } = contactPayload;
    const rows = createEmailOutboxRows(await parsedInquiry(withoutEmail), inquiry, ["inbox@example.test"]);
    expect(rows.map((row) => row.kind)).toEqual(["internal"]);
    expect(rows[0].replyTo).toBeNull();
  });
});
