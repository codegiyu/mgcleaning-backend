import { createHash } from "node:crypto";
import { createProducerRedisConnection } from "../queue/redis.js";

const WINDOW_SECONDS = 15 * 60;
const MAX_ATTEMPTS = 5;
let redis: ReturnType<typeof createProducerRedisConnection> | undefined;

/** Counts sign-in attempts by a one-way email key; Redis failure blocks sign-in. */
export async function allowLoginAttempt(email: string) {
  redis ??= createProducerRedisConnection();
  const key = createHash("sha256").update(email.toLowerCase()).digest("hex");
  const counterKey = `mg:admin-login:${key}`;
  const attempts = await redis.incr(counterKey);
  if (attempts === 1) await redis.expire(counterKey, WINDOW_SECONDS);
  return attempts <= MAX_ATTEMPTS;
}

export async function clearLoginAttempts(email: string) {
  redis ??= createProducerRedisConnection();
  const key = createHash("sha256").update(email.toLowerCase()).digest("hex");
  await redis.del(`mg:admin-login:${key}`);
}
