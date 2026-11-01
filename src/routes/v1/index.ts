import { randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Context } from "hono";
import { env } from "../../env.js";
import { logger } from "../../logger.js";
import { getRequestLogger } from "../../request-context.js";
import { effectiveNotificationEmail, readSiteSettings } from "../../settings/site-settings.js";
import { getDb } from "../../db/client.js";
import { contactInquiries } from "../../db/schema/contactInquiries.js";
import { emailOutbox, type NewEmailOutbox } from "../../db/schema/emailOutbox.js";
import { enqueueEmail, type OutboundEmailJob } from "../../queue/email.queue.js";
import {
  allowInquiryRequest,
  claimInquiryFingerprint,
  createInquiryFingerprint,
  releaseInquiryFingerprint,
  resolveClientIp,
  type RateLimitDecision,
} from "../../security/inquiry-abuse.js";
import { scoreInquiry } from "../../security/spam-score.js";
import { verifyTurnstile } from "../../security/turnstile.js";
import { adminRouter, publicBlogRouter } from "./admin.js";
import { createPublicReviewsRouter } from "./reviews.js";
import { createEventsRouter } from "./events.js";
import { createReadinessRouter } from "./readiness.js";
import { describeAttribution, normalizeAttributionValue, normalizeLandingPath } from "../../attribution.js";
import { FORM_RESPONSE_EXPECTATION, MESSAGE_RESPONSE_EXPECTATION } from "../../emails/response-expectation.js";
import { buildAlertActions } from "../../emails/alert-actions.js";

const preferredContactMethods = ["phone", "whatsapp", "either"] as const;
const preferredTimes = ["Morning (8am–12pm)", "Afternoon (12pm–4pm)", "Late afternoon (4pm–7pm)"] as const;

function isValidCalendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function isSafeLocation(value: string) {
  return /[\p{L}\p{N}]/u.test(value) && !/[\u0000-\u001F\u007F]/u.test(value) && !/^(?:https?:\/\/|www\.)/i.test(value);
}

const inquiryPayloadSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    phone: z.string().trim().min(5).max(40),
    email: z
      .string()
      .trim()
      .email()
      .max(320)
      .optional()
      .transform((value) => (value ? value : undefined)),
    inquiryType: z.enum(["contact", "booking"]).default("contact"),
    topic: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((value) => (value ? value : undefined)),
    preferredContactMethod: z
      .enum(preferredContactMethods)
      .optional()
      .transform((value) => value || undefined),
    companyWebsite: z
      .string()
      .trim()
      .max(200)
      .optional()
      .transform((value) => (value ? value : undefined)),
    turnstileToken: z
      .string()
      .trim()
      .max(4_000)
      .optional()
      .transform((value) => (value ? value : undefined)),
    serviceInterest: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((value) => (value ? value : undefined)),
    preferredDate: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a valid preferred date.")
      .refine(isValidCalendarDate, "Use a valid preferred date.")
      .refine((value) => {
        const requested = new Date(`${value}T00:00:00Z`);
        const today = new Date();
        const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
        return requested.getTime() >= todayUtc;
      }, "Preferred date cannot be in the past.")
      .refine((value) => {
        const requested = new Date(`${value}T00:00:00Z`);
        const today = new Date();
        const todayUtc = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
        return requested.getTime() <= todayUtc + env.INQUIRY_MAX_DATE_DAYS * 86_400_000;
      }, "Preferred date is too far in the future.")
      .optional()
      .transform((value) => (value ? value : undefined)),
    preferredTime: z
      .enum(preferredTimes)
      .optional()
      .transform((value) => (value ? value : undefined)),
    location: z
      .string()
      .trim()
      .max(240)
      .refine(isSafeLocation, "Add a valid service location.")
      .optional()
      .transform((value) => (value ? value : undefined)),
    spaceType: z
      .string()
      .trim()
      .max(120)
      .optional()
      .transform((value) => (value ? value : undefined)),
    message: z.string().trim().min(8).max(4_000),
    // Attribution never fails validation: bad values are dropped so the enquiry is still saved.
    utmSource: z.unknown().transform(normalizeAttributionValue).optional(),
    utmMedium: z.unknown().transform(normalizeAttributionValue).optional(),
    utmCampaign: z.unknown().transform(normalizeAttributionValue).optional(),
    utmContent: z.unknown().transform(normalizeAttributionValue).optional(),
    landingPath: z.unknown().transform(normalizeLandingPath).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.inquiryType === "booking") {
      if (!value.email) context.addIssue({ code: "custom", path: ["email"], message: "Add an email address." });
      if (!value.serviceInterest) context.addIssue({ code: "custom", path: ["serviceInterest"], message: "Choose a service." });
      if (!value.preferredDate) context.addIssue({ code: "custom", path: ["preferredDate"], message: "Choose a preferred date." });
      if (!value.preferredContactMethod) context.addIssue({ code: "custom", path: ["preferredContactMethod"], message: "Choose how the team should contact you." });
      if (!value.location) context.addIssue({ code: "custom", path: ["location"], message: "Add the service location." });
    }
    if (value.inquiryType === "contact" && !value.topic) {
      context.addIssue({ code: "custom", path: ["topic"], message: "Choose a contact topic." });
    }
  });

export type CreateInquiryInput = z.input<typeof inquiryPayloadSchema>;
/** What the route hands to persistence: validated, trimmed, and with attribution normalised. */
export type ParsedInquiry = z.output<typeof inquiryPayloadSchema>;

export type SavedInquiry = {
  id: string;
  reference: string;
  outbox: Array<{ id: string; kind: "internal" | "customer" }>;
};

export type InquiryRouterDependencies = {
  saveInquiry: (input: ParsedInquiry, idempotencyKey: string) => Promise<SavedInquiry>;
  enqueueNotification: (job: OutboundEmailJob) => Promise<unknown>;
  notificationRecipient: string;
  onNotificationQueueFailure: (inquiryId: string, outboxId: string) => void;
  allowRequest?: (input: { ip: string; email?: string; phone?: string }) => Promise<RateLimitDecision>;
  resolveClientIp?: (context: Context) => string;
  claimFingerprint?: (fingerprint: string, idempotencyKey: string) => Promise<{ claimed: boolean; owner: boolean; key: string; value: string }>;
  releaseFingerprint?: (key: string, value: string) => Promise<void>;
  verifyTurnstile?: (token: string | undefined, ip: string) => Promise<boolean>;
};

function createPublicReference() {
  const date = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  const suffix = randomBytes(3).toString("hex").toUpperCase();
  return `MG-${date}-${suffix}`;
}

function contactMethodLabel(value?: string) {
  return value === "phone" ? "Phone call" : value === "whatsapp" ? "WhatsApp" : value === "either" ? "Phone or WhatsApp" : "Not specified";
}

export function createEmailOutboxRows(
  input: ParsedInquiry,
  inquiry: { id: string; reference: string },
  recipient: string,
  adminOrigin: string = env.FRONTEND_ORIGIN,
): NewEmailOutbox[] {
  const actions = buildAlertActions({ id: inquiry.id, reference: inquiry.reference, phone: input.phone, preferredContactMethod: input.preferredContactMethod }, adminOrigin);
  const details = [
    `Request reference: ${inquiry.reference}`,
    `Name: ${input.name}`,
    `Phone: ${input.phone}`,
    `Email: ${input.email || "Not provided"}`,
    `Preferred contact: ${contactMethodLabel(input.preferredContactMethod)}`,
    `Service interest: ${input.serviceInterest || "Not specified"}`,
    `Preferred date: ${input.preferredDate || "Not specified"}`,
    `Preferred time: ${input.preferredTime || "Not specified"}`,
    `Location: ${input.location || "Not specified"}`,
    `Space type: ${input.spaceType || "Not specified"}`,
    `Came from: ${describeAttribution(input)}`,
    `Message: ${input.message}`,
  ];
  const customerMessage = [
    `Hello ${input.name},`,
    "",
    "We have received your cleaning request.",
    "",
    `Request reference: ${inquiry.reference}`,
    `Service: ${input.serviceInterest || "Not specified"}`,
    `Preferred date: ${input.preferredDate || "Not specified"}`,
    `Preferred time: ${input.preferredTime || "Not specified"}`,
    "",
    `This is a request, not a confirmed appointment. ${FORM_RESPONSE_EXPECTATION}.`,
    "",
    `For the fastest reply, message us on WhatsApp using the number on our website. ${MESSAGE_RESPONSE_EXPECTATION}.`,
  ].join("\n");
  const rows: NewEmailOutbox[] = [
    {
      inquiryId: inquiry.id,
      kind: "internal",
      to: recipient,
      subject: `New M&G Cleaning Services ${input.inquiryType === "booking" ? "cleaning request" : "contact message"} · ${inquiry.reference}`,
      title: input.inquiryType === "booking" ? "New cleaning request" : "New contact message",
      message: details.join("\n\n"),
      actions,
      replyTo: input.email ?? null,
    },
  ];
  if (input.email) {
    rows.push({
      inquiryId: inquiry.id,
      kind: "customer",
      to: input.email,
      subject: `M&G Cleaning Services request received · ${inquiry.reference}`,
      title: "Your cleaning request has been received",
      message: customerMessage,
    });
  }
  return rows;
}

async function findSavedInquiry(idempotencyKey: string) {
  const [inquiry] = await getDb()
    .select({ id: contactInquiries.id, reference: contactInquiries.publicReference })
    .from(contactInquiries)
    .where(eq(contactInquiries.idempotencyKey, idempotencyKey))
    .limit(1);
  if (!inquiry) return null;
  const outbox = await getDb()
    .select({ id: emailOutbox.id, kind: emailOutbox.kind })
    .from(emailOutbox)
    .where(eq(emailOutbox.inquiryId, inquiry.id));
  return { ...inquiry, outbox: outbox.map((item) => ({ id: item.id, kind: item.kind as "internal" | "customer" })) };
}

const productionDependencies: InquiryRouterDependencies = {
  async saveInquiry(input, idempotencyKey) {
    const db = getDb();
    return db.transaction(async (tx) => {
      const existing = await tx
        .select({ id: contactInquiries.id, reference: contactInquiries.publicReference })
        .from(contactInquiries)
        .where(eq(contactInquiries.idempotencyKey, idempotencyKey))
        .limit(1);
      if (existing[0]) {
        const outbox = await tx
          .select({ id: emailOutbox.id, kind: emailOutbox.kind })
          .from(emailOutbox)
          .where(eq(emailOutbox.inquiryId, existing[0].id));
        return { ...existing[0], outbox: outbox.map((item) => ({ id: item.id, kind: item.kind as "internal" | "customer" })) };
      }

      const [inquiry] = await tx
        .insert(contactInquiries)
        .values({
          name: input.name,
          phone: input.phone,
          email: input.email ?? null,
          publicReference: createPublicReference(),
          idempotencyKey,
          inquiryType: input.inquiryType,
          topic: input.topic ?? null,
          preferredContactMethod: input.preferredContactMethod ?? null,
          serviceInterest: input.serviceInterest ?? null,
          preferredDate: input.preferredDate ?? null,
          preferredTime: input.preferredTime ?? null,
          location: input.location ?? null,
          spaceType: input.spaceType ?? null,
          message: input.message,
          source: "website",
          utmSource: input.utmSource ?? null,
          utmMedium: input.utmMedium ?? null,
          utmCampaign: input.utmCampaign ?? null,
          utmContent: input.utmContent ?? null,
          landingPath: input.landingPath ?? null,
        })
        .onConflictDoNothing({ target: contactInquiries.idempotencyKey })
        .returning({ id: contactInquiries.id, reference: contactInquiries.publicReference });

      if (!inquiry) {
        const saved = await findSavedInquiry(idempotencyKey);
        if (!saved) throw new Error("Inquiry insert returned no row.");
        return saved;
      }

      // Read inside the transaction so the alert goes to the inbox configured when the inquiry was saved.
      const rows = createEmailOutboxRows(input, inquiry, effectiveNotificationEmail(await readSiteSettings(tx)));
      const outbox = await tx
        .insert(emailOutbox)
        .values(rows)
        .returning({ id: emailOutbox.id, kind: emailOutbox.kind });
      return { ...inquiry, outbox: outbox.map((item) => ({ id: item.id, kind: item.kind as "internal" | "customer" })) };
    });
  },
  async enqueueNotification(job) {
    return enqueueEmail(job);
  },
  notificationRecipient: env.INQUIRY_NOTIFICATION_TO,
  onNotificationQueueFailure(inquiryId, outboxId) {
    logger.warn({ inquiryId, outboxId }, "inquiry saved but its notification was not queued");
  },
  allowRequest: ({ ip, email, phone }) => allowInquiryRequest({ ip, email, phone }),
  resolveClientIp,
  claimFingerprint: claimInquiryFingerprint,
  releaseFingerprint: releaseInquiryFingerprint,
  verifyTurnstile,
};

export function createV1Router(
  dependencies: InquiryRouterDependencies = productionDependencies,
) {
  const router = new Hono();

  router.get("/health", (context) =>
    context.json({
      success: true as const,
      message: "API is healthy.",
      responseCode: 200,
      data: {
        service: "mgcleaning-backend" as const,
        status: "ok" as const,
      },
    }),
  );

  router.route("/health/ready", createReadinessRouter());
  router.route("/admin", adminRouter);
  router.route("/blog", publicBlogRouter);
  router.route("/reviews", createPublicReviewsRouter());
  router.route("/events", createEventsRouter());

  router.post(
    "/inquiries",
    bodyLimit({
      maxSize: env.INQUIRY_MAX_BODY_BYTES,
      onError: (context) => context.json({ success: false as const, message: "Request is too large.", responseCode: 413 }, 413),
    }),
    async (context) => {
    const allowRequest = dependencies.allowRequest ?? (async () => ({ allowed: true, retryAfterSeconds: 0 }));
    const resolveIp = dependencies.resolveClientIp ?? (() => "unknown");
    const claimFingerprint = dependencies.claimFingerprint ?? (async () => ({ claimed: true, owner: true, key: "", value: "" }));
    const releaseFingerprint = dependencies.releaseFingerprint ?? (async () => undefined);
    const verifyChallenge = dependencies.verifyTurnstile ?? (async () => true);

    const contentType = context.req.header("content-type")?.toLowerCase() ?? "";
    if (!contentType.startsWith("application/json")) {
      return context.json({ success: false as const, message: "JSON request body required.", responseCode: 415 }, 415);
    }
    const idempotencyKey = context.req.header("Idempotency-Key");
    if (!idempotencyKey || !z.string().uuid().safeParse(idempotencyKey).success) {
      return context.json(
        { success: false as const, message: "A valid submission key is required. Please try again.", responseCode: 400 },
        400,
      );
    }
    const body = await context.req.json().catch(() => null);
    const parsed = inquiryPayloadSchema.safeParse(body);

    if (!parsed.success) {
      return context.json(
        {
          success: false as const,
          message: "Please check the form details and try again.",
          responseCode: 400,
        },
        400,
      );
    }

    const clientIp = resolveIp(context);
    let rateLimit: RateLimitDecision;
    try {
      rateLimit = await allowRequest({ ip: clientIp, email: parsed.data.email, phone: parsed.data.phone });
    } catch {
      getRequestLogger(context).error("inquiry rate limiter unavailable");
      return context.json({ success: false as const, message: "Requests are temporarily unavailable. Please try again shortly.", responseCode: 503 }, 503);
    }
    if (!rateLimit.allowed) {
      const retryAfter = String(Math.max(1, Math.ceil(rateLimit.retryAfterSeconds)));
      return context.json(
        { success: false as const, message: "Please wait before sending another request.", responseCode: 429 },
        429,
        { "Retry-After": retryAfter },
      );
    }

    if (parsed.data.companyWebsite) {
      getRequestLogger(context).info("inquiry rejected by honeypot");
      return context.json({ success: false as const, message: "Please check the form details and try again.", responseCode: 400 }, 400);
    }

    const spamScore = scoreInquiry(parsed.data);
    if (spamScore.band === "high") {
      getRequestLogger(context).info({ score: spamScore.score, signals: spamScore.signals }, "inquiry rejected by spam score");
      return context.json({ success: false as const, message: "Please check the form details and try again.", responseCode: 400 }, 400);
    }
    if (spamScore.band === "medium" && !(await verifyChallenge(parsed.data.turnstileToken, clientIp))) {
      getRequestLogger(context).info({ score: spamScore.score, signals: spamScore.signals }, "inquiry rejected by challenge verification");
      return context.json({ success: false as const, message: "Please complete the verification and try again.", responseCode: 403 }, 403);
    }

    const fingerprint = createInquiryFingerprint(parsed.data);
    let fingerprintClaim: Awaited<ReturnType<typeof claimFingerprint>>;
    try {
      fingerprintClaim = await claimFingerprint(fingerprint, idempotencyKey);
    } catch {
      getRequestLogger(context).error("inquiry duplicate protection unavailable");
      return context.json({ success: false as const, message: "Requests are temporarily unavailable. Please try again shortly.", responseCode: 503 }, 503);
    }
    if (!fingerprintClaim.claimed) {
      return context.json(
        { success: false as const, message: "Please wait before sending another request.", responseCode: 429 },
        429,
        { "Retry-After": String(env.INQUIRY_FINGERPRINT_TTL_SECONDS) },
      );
    }

    let inquiry: SavedInquiry;
    try {
      inquiry = await dependencies.saveInquiry(parsed.data, idempotencyKey);
    } catch (error) {
      if (fingerprintClaim.owner) await releaseFingerprint(fingerprintClaim.key, fingerprintClaim.value).catch(() => undefined);
      throw error;
    }
    const queuedKinds = new Set<string>();
    for (const outboxItem of inquiry.outbox) {
      try {
        await dependencies.enqueueNotification({ outboxId: outboxItem.id });
        queuedKinds.add(outboxItem.kind);
      } catch {
        // The stored inquiry and outbox row remain the source of truth if Redis is unavailable.
        dependencies.onNotificationQueueFailure(inquiry.id, outboxItem.id);
      }
    }

    return context.json(
      {
        success: true as const,
        message: "Your inquiry has been received.",
        responseCode: 201,
        data: {
          inquiryId: inquiry.id,
          reference: inquiry.reference,
          notificationQueued: queuedKinds.has("internal"),
          internalNotificationQueued: queuedKinds.has("internal"),
          customerEmailQueued: inquiry.outbox.some((item) => item.kind === "customer") ? queuedKinds.has("customer") : null,
        },
      },
      201,
    );
    },
  );

  return router;
}

export const v1Router = createV1Router();
