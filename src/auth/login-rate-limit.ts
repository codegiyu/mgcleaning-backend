import { createHash } from "node:crypto";
import { lazyProducerConnection } from "../queue/redis.js";

const WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 5;
const connection = lazyProducerConnection();

export type AttemptScope = "admin-login" | "admin-password-change";

function counterKey(scope: AttemptScope, identifier: string) {
  const key = createHash("sha256").update(identifier.toLowerCase()).digest("hex");
  return `mg:${scope}:${key}`;
}

export type AttemptLimit = { key: string; limit: number; ttlSeconds: number };

/**
 * Sign-in limits, all of which must allow the attempt:
 * - 5 per 15 minutes for one email from one address, so guessing from one place is slow
 *   but cannot lock the real owner out from another (the old per-email limit could);
 * - 20 per 15 minutes from one address, against trying many emails;
 * - 50 per hour for one email from anywhere, a backstop against distributed guessing.
 * `clientKey` is the keyed IP hash from the audit context, never the raw IP.
 */
export function loginLimits(email: string, clientKey: string): AttemptLimit[] {
  const account = email.trim().toLowerCase();
  return [
    { key: counterKey("admin-login", `pair:${account}:${clientKey}`), limit: 5, ttlSeconds: 15 * 60 },
    { key: counterKey("admin-login", `client:${clientKey}`), limit: 20, ttlSeconds: 15 * 60 },
    { key: counterKey("admin-login", `account:${account}`), limit: 50, ttlSeconds: 60 * 60 },
  ];
}

async function consume(limits: AttemptLimit[]) {
  const redis = await connection.get();
  let allowed = true;
  for (const { key, limit, ttlSeconds } of limits) {
    const attempts = await redis.incr(key);
    if (attempts === 1) await redis.expire(key, ttlSeconds);
    if (attempts > limit) allowed = false;
  }
  return allowed;
}

/** Counts attempts by a one-way key; Redis failure blocks the attempt rather than allowing it. */
export async function allowAttempt(scope: AttemptScope, identifier: string) {
  return consume([{ key: counterKey(scope, identifier), limit: MAX_ATTEMPTS, ttlSeconds: WINDOW_SECONDS }]);
}

export async function clearAttempts(scope: AttemptScope, identifier: string) {
  const redis = await connection.get();
  await redis.del(counterKey(scope, identifier));
}

export const allowLoginAttempt = (email: string, clientKey: string) => consume(loginLimits(email, clientKey));

/** A successful sign-in clears its own email-and-address counter; the wider ones keep counting. */
export async function clearLoginAttempts(email: string, clientKey: string) {
  const redis = await connection.get();
  await redis.del(loginLimits(email, clientKey)[0].key);
}

export const closeLoginRateLimitRedis = () => connection.close();
