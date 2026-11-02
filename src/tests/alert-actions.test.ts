import { describe, expect, it } from "vitest";
import { actionsAsText, buildAlertActions, isSafeActionHref, nigerianWhatsAppNumber, plainTextBody } from "../emails/alert-actions.js";

const inquiry = { id: "3c2d57bc-11af-4c75-8b81-03a676cc1f55", reference: "MG-20261027-A1B2C3", phone: "0816 771 5346" };
const origin = "https://mgcleaning.example";

describe("nigerianWhatsAppNumber", () => {
  it.each([
    ["08167715346", "2348167715346"],
    ["0816 771 5346", "2348167715346"],
    ["0816-771-5346", "2348167715346"],
    ["+234 816 771 5346", "2348167715346"],
    ["234 (816) 771-5346", "2348167715346"],
    ["07012345678", "2347012345678"],
    ["09012345678", "2349012345678"],
  ])("normalises %s", (input, expected) => {
    expect(nigerianWhatsAppNumber(input)).toBe(expected);
  });

  it.each([
    ["too short", "0816771534"],
    ["too long", "081677153466"],
    ["not a mobile prefix", "01234567890"],
    ["another country", "+44 20 7946 0958"],
    ["letters", "0816CALLME1"],
    ["empty", ""],
  ])("rejects %s", (_label, input) => {
    expect(nigerianWhatsAppNumber(input)).toBeNull();
  });
});

describe("buildAlertActions", () => {
  it("leads with WhatsApp, then a call, then the dashboard record", () => {
    const actions = buildAlertActions({ ...inquiry, preferredContactMethod: "whatsapp" }, origin);
    expect(actions.map((action) => action.label)).toEqual(["Reply on WhatsApp", "Call", "Open in dashboard"]);
    expect(actions[0].href).toBe("https://wa.me/2348167715346?text=Hello%2C%20this%20is%20M%26G%20Cleaning%20Services%20about%20your%20request%20MG-20261027-A1B2C3.");
    expect(actions[1].href).toBe("tel:+2348167715346");
    expect(actions[2].href).toBe("https://mgcleaning.example/admin/inquiries/3c2d57bc-11af-4c75-8b81-03a676cc1f55");
  });

  it("offers WhatsApp when the customer did not state a preference", () => {
    expect(buildAlertActions(inquiry, origin).map((action) => action.label)).toEqual(["Reply on WhatsApp", "Call", "Open in dashboard"]);
  });

  it("puts the call first and drops WhatsApp when the customer asked for a phone call", () => {
    expect(buildAlertActions({ ...inquiry, preferredContactMethod: "phone" }, origin).map((action) => action.label)).toEqual(["Call", "Open in dashboard"]);
  });

  it("still links the record when the number cannot be dialled", () => {
    expect(buildAlertActions({ ...inquiry, phone: "+44 20 7946 0958" }, origin).map((action) => action.label)).toEqual(["Open in dashboard"]);
  });

  it("never puts the customer's name or message in a link", () => {
    const hrefs = buildAlertActions({ ...inquiry, preferredContactMethod: "either" }, origin).map((action) => action.href).join(" ");
    expect(hrefs).not.toMatch(/Mary|sofa/i);
  });

  it("writes the same actions as plain text", () => {
    expect(actionsAsText(buildAlertActions({ ...inquiry, preferredContactMethod: "phone" }, origin))).toBe(
      "Call: tel:+2348167715346\nOpen in dashboard: https://mgcleaning.example/admin/inquiries/3c2d57bc-11af-4c75-8b81-03a676cc1f55",
    );
  });
});

describe("plainTextBody", () => {
  it("appends the actions after the message, or leaves it alone without any", () => {
    expect(plainTextBody("Name: Ada", [{ label: "Call", href: "tel:+2348167715346" }])).toBe("Name: Ada\n\nCall: tel:+2348167715346");
    expect(plainTextBody("Hello Ada,", [])).toBe("Hello Ada,");
  });
});

describe("isSafeActionHref", () => {
  it.each([
    ["https://wa.me/2348167715346", true],
    ["tel:+2348167715346", true],
    ["http://localhost:3000/admin/inquiries/x", true],
    ["javascript:alert(1)", false],
    ["http://example.com", false],
    ["tel:0816; drop", false],
  ])("%s → %s", (href, safe) => {
    expect(isSafeActionHref(href)).toBe(safe);
  });
});
