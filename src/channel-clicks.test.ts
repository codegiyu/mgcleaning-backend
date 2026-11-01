import { describe, expect, it, vi } from "vitest";
import { MAX_CLICK_BODY_BYTES, parseChannelClick } from "./events/channel-clicks.js";
import { createEventsRouter, type EventsRouterDependencies } from "./routes/v1/events.js";

const origin = "http://localhost:3000";

function app(overrides: Partial<EventsRouterDependencies> = {}) {
  const recordClick = vi.fn<EventsRouterDependencies["recordClick"]>(async () => {});
  const dependencies: EventsRouterDependencies = {
    allowClick: async () => true,
    recordClick,
    resolveClientIp: () => "203.0.113.7",
    ...overrides,
  };
  return { router: createEventsRouter(dependencies), recordClick };
}

function send(router: ReturnType<typeof createEventsRouter>, body: unknown, headers: Record<string, string> = { Origin: origin, "Content-Type": "text/plain;charset=UTF-8" }) {
  return router.request("/channel-click", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

describe("parseChannelClick", () => {
  it("keeps the channel and normalises campaign data", () => {
    expect(parseChannelClick(JSON.stringify({ channel: "whatsapp", placement: "footer", pagePath: "/services/fumigation?x=1", utmSource: " Instagram ", utmCampaign: "Spring Reset", landingPath: "/links" }))).toEqual({
      channel: "whatsapp",
      placement: "footer",
      pagePath: "/services/fumigation",
      utmSource: "instagram",
      utmMedium: null,
      utmCampaign: "spring-reset",
      utmContent: null,
      landingPath: "/links",
    });
  });

  it("drops hostile campaign values instead of rejecting the tap", () => {
    const click = parseChannelClick(JSON.stringify({ channel: "phone", placement: "sidebar", pagePath: "//evil.example/x", utmSource: "<script>", landingPath: "https://evil.example" }));
    expect(click).toMatchObject({ channel: "phone", placement: "page", pagePath: null, utmSource: null, landingPath: null });
  });

  it.each([
    ["not JSON", "channel=whatsapp"],
    ["an unknown channel", JSON.stringify({ channel: "email" })],
    ["no channel", JSON.stringify({ pagePath: "/" })],
    ["extra fields such as an identifier", JSON.stringify({ channel: "whatsapp", phone: "08000000000" })],
  ])("rejects %s", (_label, body) => {
    expect(parseChannelClick(body)).toBeNull();
  });
});

describe("POST /channel-click", () => {
  it("stores a tap from the website and answers 204", async () => {
    const { router, recordClick } = app();
    const response = await send(router, { channel: "instagram", pagePath: "/book", utmSource: "instagram" });
    expect(response.status).toBe(204);
    expect(recordClick).toHaveBeenCalledWith(expect.objectContaining({ channel: "instagram", pagePath: "/book", utmSource: "instagram" }));
  });

  it("never stores anything that identifies the visitor", async () => {
    const { router, recordClick } = app();
    await send(router, { channel: "whatsapp", pagePath: "/" });
    const stored = recordClick.mock.calls[0][0];
    expect(Object.keys(stored).sort()).toEqual(["channel", "landingPath", "pagePath", "placement", "utmCampaign", "utmContent", "utmMedium", "utmSource"]);
    expect(JSON.stringify(stored)).not.toContain("203.0.113.7");
  });

  it("refuses other origins and malformed bodies without storing", async () => {
    const { router, recordClick } = app();
    expect((await send(router, { channel: "whatsapp" }, { Origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await send(router, { channel: "fax" })).status).toBe(400);
    expect((await send(router, "x".repeat(MAX_CLICK_BODY_BYTES + 1))).status).toBe(413);
    expect(recordClick).not.toHaveBeenCalled();
  });

  it("answers 429 over the per-visitor limit", async () => {
    const { router, recordClick } = app({ allowClick: async () => false });
    expect((await send(router, { channel: "phone" })).status).toBe(429);
    expect(recordClick).not.toHaveBeenCalled();
  });

  it("drops the tap quietly when the rate limiter is unavailable", async () => {
    const { router, recordClick } = app({ allowClick: async () => { throw new Error("Redis down"); } });
    expect((await send(router, { channel: "phone" })).status).toBe(204);
    expect(recordClick).not.toHaveBeenCalled();
  });

  it("reports a storage failure as 503", async () => {
    const { router } = app({ recordClick: async () => { throw new Error("database down"); } });
    expect((await send(router, { channel: "whatsapp" })).status).toBe(503);
  });
});
