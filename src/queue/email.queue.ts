import { Queue } from "bullmq";
import { createProducerRedisConnection } from "./redis.js";

export const EMAIL_QUEUE_NAME = "outbound-email";

export type OutboundEmailJob = {
  outboxId: string;
};

let queue: Queue<OutboundEmailJob> | undefined;
let connection: ReturnType<typeof createProducerRedisConnection> | undefined;

export function getEmailQueue() {
  if (!queue) {
    connection = createProducerRedisConnection();
    queue = new Queue<OutboundEmailJob>(EMAIL_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1_000 },
        removeOnComplete: 500,
        removeOnFail: true,
      },
    });
  }
  return queue;
}

export async function enqueueEmail(job: OutboundEmailJob) {
  return getEmailQueue().add("send-email", job, { jobId: `email-outbox-${job.outboxId}` });
}

export async function closeEmailQueue() {
  await queue?.close();
  await connection?.quit();
  queue = undefined;
  connection = undefined;
}
