import { describe, expect, it } from "vitest";
import { clientIpFromForwardedFor } from "./security/inquiry-abuse.js";

describe("client IP resolution", () => {
  it("uses the address appended by the trusted proxy, not a client-supplied one", () => {
    expect(clientIpFromForwardedFor("6.6.6.6, 198.51.100.7", 1)).toBe("198.51.100.7");
    expect(clientIpFromForwardedFor("6.6.6.6, 198.51.100.7, 10.0.0.2", 2)).toBe("198.51.100.7");
  });

  it("ignores the header when no proxies are trusted or the chain is too short", () => {
    expect(clientIpFromForwardedFor("6.6.6.6", 0)).toBeNull();
    expect(clientIpFromForwardedFor("198.51.100.7", 2)).toBeNull();
    expect(clientIpFromForwardedFor(undefined, 1)).toBeNull();
  });
});
