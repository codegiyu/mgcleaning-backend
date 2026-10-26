import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  MAX_REVALIDATION_ATTEMPTS,
  nextRetryDelayMs,
  revalidationForPostChange,
  sendRevalidation,
  signRevalidation,
} from "./cache/revalidation.js";

const now = new Date("2026-10-27T09:00:00.000Z");

describe("cache revalidation rules", () => {
  const draft = { status: "draft", slug: "deep-clean" };
  const live = { status: "published", slug: "deep-clean" };

  it("ignores changes that never touch the public site", () => {
    expect(revalidationForPostChange(draft, { ...draft, slug: "renamed" })).toBeNull();
    expect(revalidationForPostChange({ status: "scheduled", slug: "a" }, { status: "scheduled", slug: "a" })).toBeNull();
  });

  it("refreshes the list and article when an article goes live or is edited", () => {
    expect(revalidationForPostChange(draft, live)).toEqual({ tags: ["blog", "blog:deep-clean"], mode: "refresh" });
    expect(revalidationForPostChange(live, live)).toEqual({ tags: ["blog", "blog:deep-clean"], mode: "refresh" });
  });

  it("removes immediately when an article leaves the public site", () => {
    expect(revalidationForPostChange(live, draft)).toEqual({ tags: ["blog", "blog:deep-clean"], mode: "remove" });
    expect(revalidationForPostChange(live, { status: "archived", slug: "deep-clean" })?.mode).toBe("remove");
  });

  it("purges the old URL when a live slug changes", () => {
    expect(revalidationForPostChange(live, { status: "published", slug: "deep-clean-guide" })).toEqual({
      tags: ["blog", "blog:deep-clean", "blog:deep-clean-guide"],
      mode: "remove",
    });
  });
});

describe("revalidation delivery", () => {
  const target = { url: "https://www.example.test/api/revalidate", secret: "a-test-secret-that-is-at-least-32-chars" };

  it("signs the exact body with a timestamp", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 200 }));
    await sendRevalidation(target, { tags: ["blog"], mode: "refresh" }, fetchImpl, now.getTime());

    const [url, init] = fetchImpl.mock.calls[0]!;
    const headers = init?.headers as Record<string, string>;
    const timestamp = headers["X-Revalidate-Timestamp"]!;
    const expected = createHmac("sha256", target.secret).update(`${timestamp}.${String(init?.body)}`).digest("hex");

    expect(url).toBe(target.url);
    expect(timestamp).toBe(String(Math.floor(now.getTime() / 1000)));
    expect(headers["X-Revalidate-Signature"]).toBe(expected);
    expect(signRevalidation(target.secret, timestamp, String(init?.body))).toBe(expected);
  });

  it("treats a non-2xx response as a failure to retry", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(null, { status: 503 }));
    await expect(sendRevalidation(target, { tags: ["blog"], mode: "refresh" }, fetchImpl)).rejects.toThrow("503");
  });

  it("backs off exponentially and caps the delay", () => {
    expect(nextRetryDelayMs(1)).toBe(10_000);
    expect(nextRetryDelayMs(3)).toBe(40_000);
    expect(nextRetryDelayMs(MAX_REVALIDATION_ATTEMPTS)).toBe(15 * 60_000);
  });
});
