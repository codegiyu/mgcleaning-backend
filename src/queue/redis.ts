import "dotenv/config";

import { Redis } from "ioredis";

function getRedisUrl() {
  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required before using BullMQ.");
  }
  return redisUrl;
}

/** Producers fail quickly when Redis is unavailable so HTTP requests do not hang. */
export function createProducerRedisConnection() {
  return new Redis(getRedisUrl(), {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
}

/** Workers keep retrying until Redis returns, as required by BullMQ. */
export function createWorkerRedisConnection() {
  return new Redis(getRedisUrl(), { maxRetriesPerRequest: null });
}
