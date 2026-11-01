import "dotenv/config";

import { randomBytes, randomUUID } from "node:crypto";
import {
  assertSafeTarget,
  notificationOutcome,
  parseSessionCookie,
  pollUntil,
  sessionCookieProblems,
  TINY_PNG,
  type NotificationState,
} from "../smoke/helpers.js";

/**
 * End-to-end check of a deployed stack, run against staging before promoting a release:
 * inquiry → email delivery → admin session → cover upload → publish → public page →
 * unpublish → purge. It sends real email to the configured inbox and leaves clearly
 * marked, closed/archived records behind (there is no delete for inquiries or posts).
 *
 * Required: SMOKE_API_URL (https://api.staging.example/api/v1), SMOKE_WEB_URL,
 * SMOKE_ADMIN_EMAIL, SMOKE_ADMIN_PASSWORD. Optional: SMOKE_CUSTOMER_EMAIL (also tests the
 * customer confirmation), SMOKE_SKIP_MEDIA=yes, SMOKE_EMAIL_TIMEOUT_SECONDS (default 180),
 * SMOKE_ALLOW_PRODUCTION=yes.
 */

const SESSION_COOKIE = "mg_admin_session";

type Envelope<T> = { success: boolean; message: string; data?: T };

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} before running the smoke test.`);
  return value;
}

const apiUrl = required("SMOKE_API_URL").replace(/\/+$/, "");
const webUrl = required("SMOKE_WEB_URL").replace(/\/+$/, "");
const adminEmail = required("SMOKE_ADMIN_EMAIL");
const adminPassword = required("SMOKE_ADMIN_PASSWORD");
const customerEmail = process.env.SMOKE_CUSTOMER_EMAIL?.trim() || undefined;
const skipMedia = process.env.SMOKE_SKIP_MEDIA === "yes";
const emailTimeoutMs = Number(process.env.SMOKE_EMAIL_TIMEOUT_SECONDS ?? 180) * 1000;
const allowProduction = process.env.SMOKE_ALLOW_PRODUCTION === "yes";
const origin = new URL(webUrl).origin;
const runId = `${new Date().toISOString().slice(0, 10).replaceAll("-", "")}-${randomBytes(3).toString("hex")}`;

let sessionCookie = "";
const cleanups: Array<{ label: string; run: () => Promise<void> }> = [];

async function api<T>(path: string, init: RequestInit & { expect?: number[] } = {}): Promise<{ status: number; body: Envelope<T>; headers: Headers }> {
  const headers = new Headers(init.headers);
  headers.set("Origin", origin);
  if (sessionCookie) headers.set("Cookie", `${SESSION_COOKIE}=${sessionCookie}`);
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  const response = await fetch(`${apiUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(20_000) });
  const body = (await response.json().catch(() => ({ success: false, message: "Non-JSON response." }))) as Envelope<T>;
  const expected = init.expect ?? [200];
  if (!expected.includes(response.status)) {
    throw new Error(`${init.method ?? "GET"} ${path} returned ${response.status}: ${body.message}`);
  }
  return { status: response.status, body, headers: response.headers };
}

async function step<T>(label: string, run: () => Promise<T>): Promise<T> {
  const started = Date.now();
  process.stdout.write(`• ${label} … `);
  try {
    const result = await run();
    console.info(`ok (${Date.now() - started} ms)`);
    return result;
  } catch (error) {
    console.info("FAILED");
    throw error;
  }
}

async function main() {
  assertSafeTarget(apiUrl, allowProduction);
  assertSafeTarget(webUrl, allowProduction);
  console.info(`Smoke test ${runId} against ${apiUrl} and ${webUrl}`);

  await step("API health", async () => {
    const { body } = await api<{ status: string }>("/health");
    if (body.data?.status !== "ok") throw new Error("Health check did not report ok.");
  });

  const name = `Smoke Test ${runId}`;
  const inquiry = await step("Submit inquiry", async () => {
    const { body } = await api<{ reference: string }>("/inquiries", {
      method: "POST",
      expect: [201],
      headers: { "Idempotency-Key": randomUUID() },
      body: JSON.stringify({
        name,
        phone: `+234 700 ${String(Math.floor(Math.random() * 10_000_000)).padStart(7, "0")}`,
        inquiryType: "contact",
        topic: "General question",
        message: `Automated staging smoke test ${runId}. Please ignore; it will be closed automatically.`,
        utmSource: "smoke",
        utmMedium: "automation",
        utmCampaign: runId,
        landingPath: "/contact",
        ...(customerEmail ? { email: customerEmail } : {}),
      }),
    });
    if (!body.data?.reference) throw new Error("No request reference returned.");
    return body.data;
  });

  await step("Admin sign-in and cookie attributes", async () => {
    const { headers } = await api("/admin/auth/login", { method: "POST", body: JSON.stringify({ email: adminEmail, password: adminPassword }) });
    const cookie = parseSessionCookie(headers.getSetCookie(), SESSION_COOKIE);
    if (!cookie?.value) throw new Error("No session cookie was set.");
    const problems = sessionCookieProblems(cookie, apiUrl);
    if (problems.length) throw new Error(problems.join("; "));
    sessionCookie = cookie.value;
    const { body } = await api<{ authenticated: boolean }>("/admin/auth/session");
    if (!body.data?.authenticated) throw new Error("Session was not recognised after sign-in.");
  });

  const inquiryId = await step("Find inquiry and check attribution", async () => {
    const { body } = await api<{ items: Array<{ id: string; publicReference: string; utmSource: string | null; utmCampaign: string | null }> }>(
      `/admin/inquiries?query=${encodeURIComponent(name)}&pageSize=5`,
    );
    const match = body.data?.items.find((item) => item.publicReference === inquiry.reference);
    if (!match) throw new Error(`Inquiry ${inquiry.reference} is not in the admin inbox.`);
    if (match.utmSource !== "smoke" || match.utmCampaign !== runId) throw new Error("Attribution was not stored as sent.");
    return match.id;
  });
  cleanups.push({
    label: "close smoke inquiry",
    run: async () => {
      await api(`/admin/inquiries/${inquiryId}`, { method: "PATCH", body: JSON.stringify({ status: "closed", internalNote: `Automated smoke test ${runId}.` }) });
    },
  });

  await step(`Email delivery${customerEmail ? " (team and customer)" : " (team alert)"}`, async () => {
    const outcome = await pollUntil(async () => {
      const { body } = await api<{ notifications: NotificationState[] }>(`/admin/inquiries/${inquiryId}`);
      const result = notificationOutcome(body.data?.notifications ?? []);
      return result === "pending" ? null : result;
    }, { timeoutMs: emailTimeoutMs, intervalMs: 3_000 });
    if (outcome === "failed") throw new Error("An inquiry email was dead-lettered. Check the provider configuration and logs.");
  });

  if (skipMedia) {
    console.info("• Media, publishing, and cache checks skipped (SMOKE_SKIP_MEDIA=yes)");
  } else {
    const mediaId = await step("Upload cover to R2 and verify", async () => {
      const { body } = await api<{ asset: { id: string }; upload: { url: string; headers: Record<string, string> } }>("/admin/media/uploads", {
        method: "POST",
        expect: [201],
        body: JSON.stringify({ intent: "blog-cover", fileExtension: "png", byteSize: TINY_PNG.byteLength, filename: `smoke-${runId}.png`, altText: "Smoke test image" }),
      });
      if (!body.data) throw new Error("No upload ticket returned.");
      const put = await fetch(body.data.upload.url, { method: "PUT", headers: body.data.upload.headers, body: TINY_PNG, signal: AbortSignal.timeout(20_000) });
      if (!put.ok) throw new Error(`R2 upload returned ${put.status}. Check the bucket CORS rule and token.`);
      await api(`/admin/media/${body.data.asset.id}/verify`, { method: "POST" });
      return body.data.asset.id;
    });
    cleanups.push({ label: "delete smoke image", run: async () => { await api(`/admin/media/${mediaId}`, { method: "DELETE", expect: [200, 404] }); } });

    const slug = `smoke-${runId}`;
    const title = `Smoke test article ${runId}`;
    const postId = await step("Create and publish article", async () => {
      const { body } = await api<{ id: string }>("/admin/blog/posts", {
        method: "POST",
        expect: [201],
        body: JSON.stringify({
          title,
          slug,
          excerpt: "Automated smoke test article. It is unpublished automatically.",
          body: "This article checks publishing and the public cache. It is removed by the smoke test.",
          category: "Smoke test",
          authorName: "Smoke test",
          serviceSlug: "home-cleaning",
          coverMediaId: mediaId,
          coverImageAlt: "Smoke test image",
        }),
      });
      if (!body.data?.id) throw new Error("No post ID returned.");
      // Archive first and detach the cover so the image can be deleted afterwards.
      cleanups.unshift({ label: "archive smoke article", run: async () => { await api(`/admin/blog/posts/${body.data!.id}`, { method: "PATCH", body: JSON.stringify({ status: "archived", coverMediaId: null }) }); } });
      await api(`/admin/blog/posts/${body.data.id}`, { method: "PATCH", body: JSON.stringify({ status: "published" }) });
      return body.data.id;
    });

    await step("Public API and website serve the article", async () => {
      await api(`/blog/${slug}`);
      await pollUntil(async () => {
        const response = await fetch(`${webUrl}/blog/${slug}`, { signal: AbortSignal.timeout(20_000) });
        return response.ok && (await response.text()).includes(title) ? true : null;
      }, { timeoutMs: 60_000, intervalMs: 3_000 });
    });

    await step("Unpublish purges the website cache", async () => {
      await api(`/admin/blog/posts/${postId}`, { method: "PATCH", body: JSON.stringify({ status: "draft" }) });
      await api(`/blog/${slug}`, { expect: [404] });
      await pollUntil(async () => {
        const response = await fetch(`${webUrl}/blog/${slug}`, { signal: AbortSignal.timeout(20_000) });
        return response.status === 404 ? true : null;
      }, { timeoutMs: 60_000, intervalMs: 3_000 });
    });
  }
}

async function cleanUp() {
  for (const cleanup of cleanups) {
    try {
      await cleanup.run();
      console.info(`  cleanup: ${cleanup.label}`);
    } catch (error) {
      console.error(`  cleanup failed (${cleanup.label}): ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
  if (sessionCookie) {
    try {
      await api("/admin/auth/logout", { method: "POST" });
      // Re-send the old cookie: sign-out must revoke the session server-side, not just clear the browser copy.
      const { body } = await api<{ authenticated: boolean }>("/admin/auth/session");
      sessionCookie = "";
      if (body.data?.authenticated) throw new Error("Session still active after sign-out.");
      console.info("  cleanup: signed out");
    } catch (error) {
      console.error(`  sign-out check failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    }
  }
}

main()
  .then(() => console.info(`Smoke test ${runId} passed.`))
  .catch((error: unknown) => {
    console.error(`Smoke test ${runId} failed: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  })
  .finally(() => cleanUp());
