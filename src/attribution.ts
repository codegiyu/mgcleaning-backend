/**
 * Campaign attribution arrives from the visitor's URL, so it is attacker-controlled.
 * It is also never worth losing a real enquiry over: malformed values are normalised or
 * dropped, never rejected. Stored values are lowercase tokens so reports group cleanly.
 */
const MAX_ATTRIBUTION_LENGTH = 120;
const MAX_LANDING_PATH_LENGTH = 200;
const TOKEN = /^[a-z0-9][a-z0-9._~+-]*$/;
const PATH = /^\/[A-Za-z0-9\-._~/%]*$/;

export function normalizeAttributionValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, "-").slice(0, MAX_ATTRIBUTION_LENGTH);
  return TOKEN.test(normalized) ? normalized : undefined;
}

/** Same-site path only: no scheme, host, protocol-relative `//`, query, or fragment. */
export function normalizeLandingPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const path = value.trim().split(/[?#]/)[0] ?? "";
  if (path.startsWith("//") || path.length > MAX_LANDING_PATH_LENGTH) return undefined;
  return PATH.test(path) ? path : undefined;
}

export type Attribution = {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  utmContent?: string | null;
  landingPath?: string | null;
};

/** One line for the internal alert, e.g. "instagram / social / spring-reset (landed on /blog/deep-clean)". */
export function describeAttribution(attribution: Attribution) {
  const parts = [attribution.utmSource, attribution.utmMedium, attribution.utmCampaign, attribution.utmContent].filter(Boolean);
  const campaign = parts.length ? parts.join(" / ") : "Direct or unknown";
  return attribution.landingPath ? `${campaign} (landed on ${attribution.landingPath})` : campaign;
}
