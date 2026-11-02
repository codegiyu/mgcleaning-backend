import { describe, expect, it } from "vitest";
import { emailSender } from "../emails/sender.js";
import { parseEnv } from "../env.js";

describe("email sender", () => {
  it("quotes the sender name in front of the address", () => {
    expect(emailSender("forms@firefalltechnologies.ng", "M&G Cleaning Services")).toBe('"M&G Cleaning Services" <forms@firefalltechnologies.ng>');
  });

  it("uses the bare address when no name is set", () => {
    expect(emailSender("forms@firefalltechnologies.ng")).toBe("forms@firefalltechnologies.ng");
  });

  it("reads EMAIL_FROM_NAME, defaulting to M&G Cleaning Services when unset or blank", () => {
    expect(parseEnv({ EMAIL_FROM_NAME: " M&G Bookings " }).EMAIL_FROM_NAME).toBe("M&G Bookings");
    expect(parseEnv({ EMAIL_FROM_NAME: "" }).EMAIL_FROM_NAME).toBe("M&G Cleaning Services");
    expect(parseEnv({}).EMAIL_FROM_NAME).toBe("M&G Cleaning Services");
  });

  it.each(['M&G "Cleaning"', "M&G <Cleaning>", "M&G\nBcc: someone@example.com"])("refuses a sender name that could break the header: %s", (name) => {
    expect(() => parseEnv({ EMAIL_FROM_NAME: name })).toThrow();
  });
});
