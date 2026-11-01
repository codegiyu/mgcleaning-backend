import { and, inArray, lt, ne } from "drizzle-orm";
import type { Logger } from "pino";
import { getDb } from "../db/client.js";
import { adminAuditEvents } from "../db/schema/adminAuditEvents.js";
import { adminSessions } from "../db/schema/adminSessions.js";
import { cacheRevalidations } from "../db/schema/cacheRevalidations.js";
import { channelClicks } from "../db/schema/channelClicks.js";
import { contactInquiries } from "../db/schema/contactInquiries.js";
import { emailOutbox } from "../db/schema/emailOutbox.js";
import { logger as rootLogger } from "../logger.js";

const DAY_MS = 86_400_000;

/**
 * How long data is kept (agreed with M&G on 2026-11-01). Also stated on the website's
 * privacy page; keep the two in step.
 */
export const RETENTION = {
  /** Enquiries, including their contact details and notes. Their email rows go with them. */
  inquiriesDays: 730,
  /** Sent or failed email copies keep the enquiry details in their body; scrub those after 90 days. */
  emailBodiesDays: 90,
  auditEventsDays: 730,
  channelClicksDays: 395,
  /** Finished cache purges are only useful for troubleshooting. */
  cacheRevalidationsDays: 30,
} as const;

export type RetentionCutoffs = {
  inquiriesBefore: Date;
  emailBodiesBefore: Date;
  auditEventsBefore: Date;
  channelClicksBefore: Date;
  cacheRevalidationsBefore: Date;
  sessionsExpiredBefore: Date;
};

export function retentionCutoffs(now: Date): RetentionCutoffs {
  const daysAgo = (days: number) => new Date(now.getTime() - days * DAY_MS);
  return {
    inquiriesBefore: daysAgo(RETENTION.inquiriesDays),
    emailBodiesBefore: daysAgo(RETENTION.emailBodiesDays),
    auditEventsBefore: daysAgo(RETENTION.auditEventsDays),
    channelClicksBefore: daysAgo(RETENTION.channelClicksDays),
    cacheRevalidationsBefore: daysAgo(RETENTION.cacheRevalidationsDays),
    sessionsExpiredBefore: now,
  };
}

/** Each step deletes or scrubs rows older than its cutoff and returns how many it touched. */
export type RetentionDependencies = {
  deleteInquiries: (before: Date) => Promise<number>;
  scrubEmailBodies: (before: Date) => Promise<number>;
  deleteAuditEvents: (before: Date) => Promise<number>;
  deleteChannelClicks: (before: Date) => Promise<number>;
  deleteCacheRevalidations: (before: Date) => Promise<number>;
  deleteExpiredSessions: (before: Date) => Promise<number>;
};

const productionDependencies: RetentionDependencies = {
  async deleteInquiries(before) {
    // email_outbox rows cascade with their enquiry.
    const rows = await getDb().delete(contactInquiries).where(lt(contactInquiries.createdAt, before)).returning({ id: contactInquiries.id });
    return rows.length;
  },
  async scrubEmailBodies(before) {
    const rows = await getDb()
      .update(emailOutbox)
      .set({ message: "", to: "", replyTo: null, actions: [], updatedAt: new Date() })
      .where(and(inArray(emailOutbox.status, ["sent", "dead_letter"]), lt(emailOutbox.createdAt, before), ne(emailOutbox.message, "")))
      .returning({ id: emailOutbox.id });
    return rows.length;
  },
  async deleteAuditEvents(before) {
    const rows = await getDb().delete(adminAuditEvents).where(lt(adminAuditEvents.createdAt, before)).returning({ id: adminAuditEvents.id });
    return rows.length;
  },
  async deleteChannelClicks(before) {
    const rows = await getDb().delete(channelClicks).where(lt(channelClicks.createdAt, before)).returning({ id: channelClicks.id });
    return rows.length;
  },
  async deleteCacheRevalidations(before) {
    const rows = await getDb()
      .delete(cacheRevalidations)
      .where(and(inArray(cacheRevalidations.status, ["sent", "dead_letter"]), lt(cacheRevalidations.createdAt, before)))
      .returning({ id: cacheRevalidations.id });
    return rows.length;
  },
  async deleteExpiredSessions(before) {
    const rows = await getDb().delete(adminSessions).where(lt(adminSessions.expiresAt, before)).returning({ id: adminSessions.id });
    return rows.length;
  },
};

/**
 * One retention pass. Idempotent and safe to run on several instances at once: every
 * step only removes or blanks rows already past their cutoff. A failing step is logged
 * and the others still run.
 */
export async function runRetention(now = new Date(), dependencies: RetentionDependencies = productionDependencies, logger: Logger = rootLogger) {
  const cutoffs = retentionCutoffs(now);
  const steps = [
    ["inquiriesDeleted", () => dependencies.deleteInquiries(cutoffs.inquiriesBefore)],
    ["emailBodiesScrubbed", () => dependencies.scrubEmailBodies(cutoffs.emailBodiesBefore)],
    ["auditEventsDeleted", () => dependencies.deleteAuditEvents(cutoffs.auditEventsBefore)],
    ["channelClicksDeleted", () => dependencies.deleteChannelClicks(cutoffs.channelClicksBefore)],
    ["cacheRevalidationsDeleted", () => dependencies.deleteCacheRevalidations(cutoffs.cacheRevalidationsBefore)],
    ["sessionsDeleted", () => dependencies.deleteExpiredSessions(cutoffs.sessionsExpiredBefore)],
  ] as const;
  const counts: Record<string, number> = {};
  for (const [name, step] of steps) {
    try {
      counts[name] = await step();
    } catch (error) {
      logger.error({ err: error, step: name }, "retention step failed");
      counts[name] = -1;
    }
  }
  return counts;
}

const RETENTION_INTERVAL_MS = 6 * 60 * 60_000;

/** Runs at start-up and every six hours; quiet unless something was removed or failed. */
export function startRetention(logger: Logger = rootLogger.child({ component: "retention" })) {
  async function tick() {
    const counts = await runRetention(new Date(), productionDependencies, logger);
    if (Object.values(counts).some((count) => count !== 0)) logger.info(counts, "retention pass completed");
  }
  void tick();
  const timer = setInterval(() => void tick(), RETENTION_INTERVAL_MS);
  timer.unref();
  return { close: () => clearInterval(timer) };
}
