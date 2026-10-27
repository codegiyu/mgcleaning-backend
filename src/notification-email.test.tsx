import { render } from "react-email";
import { describe, expect, it } from "vitest";
import { NotificationEmail } from "./emails/notification.js";

describe("NotificationEmail", () => {
  it("renders the actions as buttons above the details", async () => {
    const html = await render(
      <NotificationEmail
        title="New cleaning request"
        message={"Request reference: MG-20261027-A1B2C3\n\nName: Mary Example"}
        actions={[
          { label: "Reply on WhatsApp", href: "https://wa.me/2348167715346" },
          { label: "Call", href: "tel:+2348167715346" },
        ]}
      />,
    );
    expect(html).toContain('href="https://wa.me/2348167715346"');
    expect(html).toContain('href="tel:+2348167715346"');
    expect(html.indexOf("Reply on WhatsApp")).toBeLessThan(html.indexOf("Request reference"));
  });

  it("drops any action whose link is not a known safe kind", async () => {
    const html = await render(
      <NotificationEmail title="New contact message" message="Hello" actions={[{ label: "Bad", href: "javascript:alert(1)" }]} />,
    );
    expect(html).not.toContain("javascript:");
    expect(html).not.toContain(">Bad<");
  });

  it("renders as before when there are no actions", async () => {
    const html = await render(<NotificationEmail title="Your cleaning request has been received" message="Hello Mary," />);
    expect(html).toContain("Your cleaning request has been received");
    expect(html).not.toContain("<a ");
  });
});
