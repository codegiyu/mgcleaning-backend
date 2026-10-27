import { describe, expect, it } from "vitest";
import { FORM_RESPONSE_EXPECTATION, MESSAGE_RESPONSE_EXPECTATION } from "./emails/response-expectation.js";
import { createEmailOutboxRows, createV1Router, type InquiryRouterDependencies, type ParsedInquiry } from "./routes/v1/index.js";

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
    const rows = createEmailOutboxRows(await parsedInquiry(contactPayload), inquiry, "inbox@example.test");
    const receipt = rows.find((row) => row.kind === "customer");
    expect(receipt?.message).toContain(`${FORM_RESPONSE_EXPECTATION}.`);
    expect(receipt?.message).toContain(`${MESSAGE_RESPONSE_EXPECTATION}.`);
    expect(receipt?.message).not.toMatch(/business day/i);
  });

  it("sends no receipt when the customer gave no email", async () => {
    const { email: _omitted, ...withoutEmail } = contactPayload;
    const rows = createEmailOutboxRows(await parsedInquiry(withoutEmail), inquiry, "inbox@example.test");
    expect(rows.map((row) => row.kind)).toEqual(["internal"]);
  });
});
