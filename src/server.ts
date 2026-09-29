import "dotenv/config";

import { serve } from "@hono/node-server";
import { app } from "./app.js";
import { closeDb } from "./db/client.js";
import { env } from "./env.js";
import { closeEmailQueue } from "./queue/email.queue.js";
import { startEmailWorker } from "./queue/email.worker.js";
import { closeInquiryAbuseRedis } from "./security/inquiry-abuse.js";

const emailWorker = startEmailWorker();

const server = serve({
  fetch: app.fetch,
  hostname: "0.0.0.0",
  port: env.API_PORT,
});

console.info(`MG Cleaning API listening on port ${env.API_PORT}.`);

let isShuttingDown = false;

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    if (isShuttingDown) return;
    isShuttingDown = true;

    server.close((error) => {
      if (error) {
        console.error("API server shutdown failed", error);
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
            console.error("Backend resource shutdown failed", result.reason);
            process.exitCode = 1;
          }
        }
      });
    });
  });
}
