import { env } from "../env.js";

type TurnstileResponse = { success?: boolean; "error-codes"?: string[] };

export async function verifyTurnstile(token: string | undefined, remoteIp: string) {
  if (env.TURNSTILE_MODE === "off") return true;
  if (!token || !env.TURNSTILE_SECRET_KEY) return false;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.TURNSTILE_TIMEOUT_MS);
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(remoteIp !== "unknown" ? { remoteip: remoteIp } : {}) }),
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const result = (await response.json()) as TurnstileResponse;
    return result.success === true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}
