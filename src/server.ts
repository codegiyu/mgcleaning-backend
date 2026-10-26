import "dotenv/config";

import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { closeDb } from "./db/client.js";
import { env } from "./env.js";
import { logger } from "./logger.js";
import { closeEmailQueue } from "./queue/email.queue.js";
import { startEmailWorker } from "./queue/email.worker.js";
import { closeInquiryAbuseRedis } from "./security/inquiry-abuse.js";

const emailWorker = startEmailWorker();

const server = serve({
  fetch: app.fetch,
  hostname: "0.0.0.0",
  port: env.API_PORT,
});

logger.info({ port: env.API_PORT }, "API listening");

let isShuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    server.close((error) => {
      if (error) {
        logger.error({ err: error }, "API server shutdown failed");
        process.exitCode = 1;
      }

      void Promise.allSettled([
        emailWorker.close(),
        closeEmailQueue(),
        closeInquiryAbuseRedis(),
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
  });
}
