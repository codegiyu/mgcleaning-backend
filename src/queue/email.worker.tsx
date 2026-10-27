import "dotenv/config";

import { Worker } from "bullmq";
import { and, eq, lte, or } from "drizzle-orm";
import { render } from "react-email";
import nodemailer from "nodemailer";
import { Resend } from "resend";
import { env } from "../env.js";
import { logger as rootLogger } from "../logger.js";
import { getDb } from "../db/client.js";
import { emailOutbox } from "../db/schema/emailOutbox.js";
import { NotificationEmail } from "../emails/notification.js";
import { plainTextBody } from "../emails/alert-actions.js";
import { enqueueEmail, EMAIL_QUEUE_NAME, type OutboundEmailJob } from "./email.queue.js";
import { createWorkerRedisConnection } from "./redis.js";

export function startEmailWorker() {
  const logger = rootLogger.child({ component: "email-worker" });
  const resend =
    env.EMAIL_PROVIDER === "resend"
      ? (() => {
          if (!env.RESEND_API_KEY) {
            throw new Error("RESEND_API_KEY is required when EMAIL_PROVIDER=resend.");
          }
          return new Resend(env.RESEND_API_KEY);
        })()
      : undefined;

  const transporter =
    env.EMAIL_PROVIDER === "smtp"
      ? (() => {
          if (!env.SMTP_HOST) {
            throw new Error("SMTP_HOST is required when EMAIL_PROVIDER=smtp.");
          }
          return nodemailer.createTransport({
            host: env.SMTP_HOST,
            port: env.SMTP_PORT,
            secure: env.SMTP_SECURE,
            ...(env.SMTP_USER && env.SMTP_PASSWORD
              ? { auth: { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } }
              : {}),
          });
        })()
      : undefined;

  const redis = createWorkerRedisConnection();
  const worker = new Worker<OutboundEmailJob>(
    EMAIL_QUEUE_NAME,
    async (job) => {
      const [outbox] = await getDb()
        .select()
        .from(emailOutbox)
        .where(eq(emailOutbox.id, job.data.outboxId))
        .limit(1);
      if (!outbox) return;
      if (outbox.status === "sent" || outbox.status === "dead_letter") return;

      if (outbox.attempts >= env.INQUIRY_MAX_EMAIL_ATTEMPTS) {
        await getDb()
          .update(emailOutbox)
          .set({ status: "dead_letter", updatedAt: new Date() })
          .where(eq(emailOutbox.id, outbox.id));
        return;
      }

      await getDb()
        .update(emailOutbox)
        .set({ status: "processing", attempts: outbox.attempts + 1, updatedAt: new Date(), lastError: null })
        .where(eq(emailOutbox.id, outbox.id));

      try {
        const html = await render(
          <NotificationEmail title={outbox.title} message={outbox.message} actions={outbox.actions} />,
        );
        const text = plainTextBody(outbox.message, outbox.actions);
        if (resend) {
          const { error } = await resend.emails.send({
            from: env.EMAIL_FROM,
            to: outbox.to,
            subject: outbox.subject,
            text,
            html,
            ...(outbox.replyTo ? { replyTo: outbox.replyTo } : {}),
          });
          if (error) {
            throw new Error(`Resend rejected email job ${job.id}: ${error.message}`);
          }
        } else {
          await transporter!.sendMail({
            from: env.EMAIL_FROM,
            to: outbox.to,
            subject: outbox.subject,
            text,
            html,
            ...(outbox.replyTo ? { replyTo: outbox.replyTo } : {}),
          });
        }

        await getDb()
          .update(emailOutbox)
          .set({ status: "sent", sentAt: new Date(), updatedAt: new Date(), lastError: null })
          .where(eq(emailOutbox.id, outbox.id));
      } catch (error) {
        const nextAttempts = outbox.attempts + 1;
        const message = error instanceof Error ? error.message : "Email delivery failed.";
        const safeMessage = message.replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted-email]").slice(0, 500);
        const permanentlyInvalid = /invalid|malformed|recipient.*not found|mailbox unavailable|550/i.test(message);
        const deadLetter = permanentlyInvalid || nextAttempts >= env.INQUIRY_MAX_EMAIL_ATTEMPTS;
        await getDb()
          .update(emailOutbox)
          .set({
            status: deadLetter ? "dead_letter" : "failed",
            lastError: safeMessage,
            availableAt: new Date(Date.now() + Math.min(60_000 * 2 ** Math.max(0, nextAttempts - 1), 3_600_000)),
            updatedAt: new Date(),
          })
          .where(eq(emailOutbox.id, outbox.id));
        throw error;
      }
    },
    { connection: redis, concurrency: 5 },
  );

  worker.on("completed", (job) => logger.info({ jobId: job.id }, "email job completed"));
  worker.on("failed", (job, error) => {
    logger.error(
      { jobId: job?.id ?? "unknown", outboxId: job?.data.outboxId, errorType: error instanceof Error ? error.name : "unknown" },
      "email job failed",
    );
  });
  worker.on("error", (error) => {
    logger.error({ err: error }, "email worker error");
  });

  async function enqueuePendingOutbox() {
    try {
      const staleProcessingCutoff = new Date(Date.now() - 10 * 60_000);
      const pending = await getDb()
        .select({ id: emailOutbox.id })
        .from(emailOutbox)
        .where(
          and(
            or(
              eq(emailOutbox.status, "pending"),
              eq(emailOutbox.status, "failed"),
              and(eq(emailOutbox.status, "processing"), lte(emailOutbox.updatedAt, staleProcessingCutoff)),
            ),
            lte(emailOutbox.availableAt, new Date()),
          ),
        )
        .limit(100);
      await Promise.all(pending.map((item) => enqueueEmail({ outboxId: item.id })));
    } catch (error) {
      logger.error({ err: error }, "email outbox recovery scan failed");
    }
  }

  void enqueuePendingOutbox();
  const recoveryTimer = setInterval(() => void enqueuePendingOutbox(), 15_000);
  recoveryTimer.unref();

  logger.info({ provider: env.EMAIL_PROVIDER }, "email worker started");

  return {
    async close() {
      clearInterval(recoveryTimer);
      await worker.close();
      await redis.quit();
    },
  };
}
