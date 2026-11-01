import "dotenv/config";

import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { closeDb } from "./db/client.js";
import { env } from "./env.js";
import { startScheduledPublisher } from "./blog/scheduler.js";
import { startRevalidationDispatcher } from "./cache/revalidation.js";
import { startMediaMaintenance } from "./media/maintenance.js";
import { startRetention } from "./maintenance/retention.js";
import { logger } from "./logger.js";
import { closeEmailQueue } from "./queue/email.queue.js";
import { startEmailWorker } from "./queue/email.worker.js";
import { closeInquiryAbuseRedis } from "./security/inquiry-abuse.js";
import { closeLoginRateLimitRedis } from "./auth/login-rate-limit.js";
import { closeChannelClickRedis } from "./events/channel-clicks.js";
import { closeReadinessRedis } from "./routes/v1/readiness.js";

const emailWorker = startEmailWorker();
const mediaMaintenance = startMediaMaintenance();
const revalidationDispatcher = startRevalidationDispatcher();
const scheduledPublisher = startScheduledPublisher();
const retention = startRetention();

const server = serve({
  fetch: app.fetch,
  hostname: "0.0.0.0",
  port: env.API_PORT,
});

logger.info({ port: env.API_PORT }, "API listening");

let isShuttingDown = false;

/** Stop taking work, drain what is in flight, close pools, then exit (with `exitCode` if set). */
function shutdown(reason: string, exitCode?: number) {
  if (exitCode !== undefined) process.exitCode = exitCode;
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ reason }, "API shutting down");
  mediaMaintenance.close();
  revalidationDispatcher.close();
  scheduledPublisher.close();
  retention.close();
  // If draining hangs, still exit so the container restarts rather than serving half-broken.
  setTimeout(() => process.exit(process.exitCode ?? 1), 15_000).unref();

  server.close((error) => {
    if (error) {
      logger.error({ err: error }, "API server shutdown failed");
      process.exitCode = 1;
    }

    void Promise.allSettled([
      emailWorker.close(),
      closeEmailQueue(),
      closeInquiryAbuseRedis(),
      closeLoginRateLimitRedis(),
      closeChannelClickRedis(),
      closeReadinessRedis(),
      closeDb(),
    ]).then((results) => {
      for (const result of results) {
        if (result.status === "rejected") {
          logger.error({ err: result.reason }, "backend resource shutdown failed");
          process.exitCode = 1;
        }
      }
    });
  });
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => shutdown(signal));
}

// Last-resort nets: an error nothing handled leaves the process in an unknown state, so
// log it and shut down cleanly; the orchestrator restarts the container.
process.on("unhandledRejection", (reason) => {
  logger.fatal({ err: reason }, "unhandled promise rejection");
  shutdown("unhandledRejection", 1);
});
process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "uncaught exception");
  shutdown("uncaughtException", 1);
});
