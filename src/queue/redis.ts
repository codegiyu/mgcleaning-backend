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

/** How long a request waits for a connection that is still being established. */
export const READY_TIMEOUT_MS = 2_000;

type ConnectionEvents = Pick<Redis, "status" | "once" | "off">;

/**
 * Resolve once the client can accept commands. With `enableOfflineQueue: false`,
 * a command sent while the connection is still opening fails at once, which made
 * the first sign-in and the first enquiry after every restart fail. Waiting here is
 * bounded, so an unreachable Redis still fails the request quickly.
 */
export function whenRedisReady(client: ConnectionEvents, timeoutMs = READY_TIMEOUT_MS): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  if (client.status === "end") return Promise.reject(new Error("Redis connection has been closed."));
  return new Promise((resolve, reject) => {
    const settle = (error?: Error) => {
      clearTimeout(timer);
      client.off("ready", onReady);
      client.off("error", onError);
      client.off("end", onEnd);
      if (error) reject(error);
      else resolve();
    };
    const onReady = () => settle();
    const onError = (error: Error) => settle(error);
    const onEnd = () => settle(new Error("Redis connection has been closed."));
    const timer = setTimeout(() => settle(new Error(`Redis was not ready within ${timeoutMs} ms.`)), timeoutMs);
    client.once("ready", onReady);
    client.once("error", onError);
    client.once("end", onEnd);
  });
}

/**
 * A producer connection opened on first use and shared afterwards. `get()` waits
 * until it is ready; `close()` lets graceful shutdown release it.
 */
export function lazyProducerConnection(create: () => Redis = createProducerRedisConnection) {
  let client: Redis | undefined;
  return {
    async get() {
      client ??= create();
      await whenRedisReady(client);
      return client;
    },
    async close() {
      await client?.quit();
      client = undefined;
    },
  };
}
