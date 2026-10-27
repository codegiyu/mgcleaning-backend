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

/** Counts attempts by a one-way key; Redis failure blocks the attempt rather than allowing it. */
export async function allowAttempt(scope: AttemptScope, identifier: string) {
  const redis = await connection.get();
  const key = counterKey(scope, identifier);
  const attempts = await redis.incr(key);
  if (attempts === 1) await redis.expire(key, WINDOW_SECONDS);
  return attempts <= MAX_ATTEMPTS;
}

export async function clearAttempts(scope: AttemptScope, identifier: string) {
  const redis = await connection.get();
  await redis.del(counterKey(scope, identifier));
}

export const closeLoginRateLimitRedis = () => connection.close();

export const allowLoginAttempt = (email: string) => allowAttempt("admin-login", email);
export const clearLoginAttempts = (email: string) => clearAttempts("admin-login", email);
