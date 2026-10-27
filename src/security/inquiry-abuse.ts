import { createHmac } from "node:crypto";
import type { Context } from "hono";
import { getConnInfo } from "@hono/node-server/conninfo";
import { Redis } from "ioredis";
import { env } from "../env.js";
import { lazyProducerConnection } from "../queue/redis.js";

export type InquiryAbuseInput = {
  email?: string;
  phone?: string;
};

export type RateLimitDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
  reason?: "ip-window" | "ip-day" | "email-day" | "phone-day";
};

const rateLimitScript = `
local blocked = 0
local retry = 0
local reason = ""
for i, key in ipairs(KEYS) do
  local limit = tonumber(ARGV[(i - 1) * 2 + 1])
  local ttl = tonumber(ARGV[(i - 1) * 2 + 2])
  local current = redis.call("INCR", key)
  if current == 1 then redis.call("EXPIRE", key, ttl) end
  local remaining = redis.call("TTL", key)
  if current > limit then
    blocked = 1
    if remaining > retry then retry = remaining end
    if reason == "" then reason = tostring(i) end
  end
end
return { blocked, retry, reason }
`;

const releaseFingerprintScript = `
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

const connection = lazyProducerConnection(() => {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) throw new Error("REDIS_URL is required for inquiry abuse protection.");
  return new Redis(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
});

function digest(value: string) {
  return createHmac("sha256", env.INQUIRY_SECURITY_SECRET).update(value).digest("hex");
}

function normalizeEmail(value: string) {
  return value.trim().toLowerCase();
}

function normalizePhone(value: string) {
  return value.trim().replace(/[^\d+]/g, "");
}

function normalizeIp(value: string) {
  const normalized = value.trim().toLowerCase();
  return normalized.startsWith("::ffff:") ? normalized.slice(7) : normalized;
}

/**
 * Each trusted proxy appends the address it received the request from, so the
 * client is `trustedHops` entries from the right. Entries further left are
 * client-supplied and must not be trusted.
 */
export function clientIpFromForwardedFor(header: string | undefined, trustedHops: number) {
  if (!header || trustedHops < 1) return null;
  const entries = header.split(",").map((entry) => entry.trim()).filter(Boolean);
  const candidate = entries[entries.length - trustedHops];
  return candidate ? normalizeIp(candidate) : null;
}

export function resolveClientIp(context: Context) {
  const forwardedIp = clientIpFromForwardedFor(context.req.header("x-forwarded-for"), env.TRUST_PROXY_HOPS);
  if (forwardedIp) return forwardedIp;

  try {
    const address = getConnInfo(context).remote.address;
    if (address) return normalizeIp(address);
  } catch {
    // In-memory Hono requests do not have a socket address. Production Node requests do.
  }
  return "unknown";
}

export async function allowInquiryRequest(
  input: InquiryAbuseInput & { ip: string },
): Promise<RateLimitDecision> {
  const keyInputs = [
    { key: `inquiry:rate:ip:window:${digest(input.ip)}`, limit: env.INQUIRY_RATE_LIMIT_PER_WINDOW, ttl: env.INQUIRY_RATE_LIMIT_WINDOW_SECONDS, reason: "ip-window" as const },
    { key: `inquiry:rate:ip:day:${digest(input.ip)}`, limit: env.INQUIRY_RATE_LIMIT_PER_DAY, ttl: env.INQUIRY_RATE_LIMIT_DAY_SECONDS, reason: "ip-day" as const },
    ...(input.email ? [{ key: `inquiry:rate:email:day:${digest(normalizeEmail(input.email))}`, limit: env.INQUIRY_IDENTITY_LIMIT_PER_DAY, ttl: env.INQUIRY_RATE_LIMIT_DAY_SECONDS, reason: "email-day" as const }] : []),
    ...(input.phone ? [{ key: `inquiry:rate:phone:day:${digest(normalizePhone(input.phone))}`, limit: env.INQUIRY_IDENTITY_LIMIT_PER_DAY, ttl: env.INQUIRY_RATE_LIMIT_DAY_SECONDS, reason: "phone-day" as const }] : []),
  ];
  const redis = await connection.get();
  const result = (await redis.eval(
    rateLimitScript,
    keyInputs.length,
    ...keyInputs.flatMap((item) => [item.key]),
    ...keyInputs.flatMap((item) => [String(item.limit), String(item.ttl)]),
  )) as [number, number, string];
  const reasonIndex = Number(result[2] || 0) - 1;
  return {
    allowed: result[0] === 0,
    retryAfterSeconds: Math.max(1, Number(result[1] || env.INQUIRY_RATE_LIMIT_WINDOW_SECONDS)),
    ...(reasonIndex >= 0 && keyInputs[reasonIndex] ? { reason: keyInputs[reasonIndex].reason } : {}),
  };
}

export function createInquiryFingerprint(input: Record<string, string | undefined>) {
  const normalized = [
    input.inquiryType,
    input.email ? normalizeEmail(input.email) : "",
    input.phone ? normalizePhone(input.phone) : "",
    input.serviceInterest?.trim().toLowerCase() ?? "",
    input.preferredDate ?? "",
    input.message?.trim().toLowerCase().replace(/\s+/g, " ") ?? "",
    input.location?.trim().toLowerCase().replace(/\s+/g, " ") ?? "",
  ].join("|");
  return digest(normalized);
}

export async function claimInquiryFingerprint(fingerprint: string, idempotencyKey: string) {
  const key = `inquiry:fingerprint:${fingerprint}`;
  const redis = await connection.get();
  const result = await redis.set(key, idempotencyKey, "EX", env.INQUIRY_FINGERPRINT_TTL_SECONDS, "NX");
  if (result === "OK") return { claimed: true, owner: true, key, value: idempotencyKey };
  const existingValue = await redis.get(key);
  return { claimed: existingValue === idempotencyKey, owner: false, key, value: idempotencyKey };
}

export async function releaseInquiryFingerprint(key: string, value: string) {
  const redis = await connection.get();
  await redis.eval(releaseFingerprintScript, 1, key, value);
}

export const closeInquiryAbuseRedis = () => connection.close();
