/**
 * Pure helpers for the staging smoke test (`src/scripts/smoke.ts`), kept separate so
 * they can be unit-tested without a running stack.
 */

const NON_PRODUCTION_LABELS = ["staging", "stage", "test", "dev", "preview", "qa", "sandbox"];

/**
 * The smoke test writes data and sends real email, so it only targets local or clearly
 * non-production hosts unless the operator explicitly opts in.
 */
export function assertSafeTarget(url: string, allowProduction: boolean) {
  const { hostname } = new URL(url);
  if (allowProduction) return;
  if (hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]" || hostname.endsWith(".localhost")) return;
  const labels = hostname.toLowerCase().split(".").flatMap((label) => label.split("-"));
  if (labels.some((label) => NON_PRODUCTION_LABELS.includes(label))) return;
  throw new Error(`Refusing to run against ${hostname}: it does not look like staging. Set SMOKE_ALLOW_PRODUCTION=yes to override.`);
}

export type SessionCookie = {
  value: string;
  httpOnly: boolean;
  secure: boolean;
  sameSite: string | null;
  path: string | null;
};

export function parseSessionCookie(setCookieHeaders: string[], name: string): SessionCookie | null {
  for (const header of setCookieHeaders) {
    const [pair, ...attributes] = header.split(";").map((part) => part.trim());
    if (!pair?.startsWith(`${name}=`)) continue;
    const lookup = (attribute: string) =>
      attributes.find((part) => part.toLowerCase().startsWith(`${attribute.toLowerCase()}=`))?.split("=")[1] ?? null;
    const has = (attribute: string) => attributes.some((part) => part.toLowerCase() === attribute.toLowerCase());
    return {
      value: pair.slice(name.length + 1),
      httpOnly: has("HttpOnly"),
      secure: has("Secure"),
      sameSite: lookup("SameSite"),
      path: lookup("Path"),
    };
  }
  return null;
}

/** Problems with the admin session cookie as deployed; an empty list means it is safe. */
export function sessionCookieProblems(cookie: SessionCookie, apiUrl: string) {
  const problems: string[] = [];
  if (!cookie.httpOnly) problems.push("cookie is not HttpOnly");
  if (cookie.sameSite?.toLowerCase() !== "lax") problems.push(`cookie SameSite is ${cookie.sameSite ?? "unset"}, expected Lax`);
  if (new URL(apiUrl).protocol === "https:" && !cookie.secure) problems.push("cookie is not Secure on an HTTPS deployment");
  if (cookie.path !== "/api/v1/admin") problems.push(`cookie Path is ${cookie.path ?? "unset"}, expected /api/v1/admin`);
  return problems;
}

/** A valid 1×1 transparent PNG: real image bytes, so upload verification exercises the signature check. */
export const TINY_PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"),
);

export async function pollUntil<T>(
  check: () => Promise<T | null>,
  { timeoutMs, intervalMs, sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)), now = Date.now }: {
    timeoutMs: number;
    intervalMs: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<T> {
  const deadline = now() + timeoutMs;
  for (;;) {
    const result = await check();
    if (result !== null) return result;
    if (now() >= deadline) throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)} seconds.`);
    await sleep(intervalMs);
  }
}

export type NotificationState = { kind: string; status: string };

/** `sent` when every email went out, `failed` once any is dead-lettered, otherwise still `pending`. */
export function notificationOutcome(notifications: NotificationState[]) {
  if (notifications.some((item) => item.status === "dead_letter")) return "failed" as const;
  if (notifications.length > 0 && notifications.every((item) => item.status === "sent")) return "sent" as const;
  return "pending" as const;
}
