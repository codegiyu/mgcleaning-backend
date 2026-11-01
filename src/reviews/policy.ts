import { z } from "zod";
import type { AuditAction } from "../audit/audit.js";
import type { NewReview, Review } from "../db/schema/reviews.js";

export const reviewStatuses = ["draft", "published"] as const;
export type ReviewStatus = (typeof reviewStatuses)[number];

export const reviewSources = ["whatsapp", "instagram", "google", "email", "in_person", "other"] as const;
export type ReviewSource = (typeof reviewSources)[number];

/** Public reviews are capped so one request can never return an unbounded list. */
export const PUBLIC_REVIEW_LIMIT = 50;

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F]/;
const LINK_PATTERN = /(?:https?:\/\/|www\.)/i;

/** A short public label (name or context line): one line, no markup or links. */
function labelSchema(max: number) {
  return z
    .string()
    .trim()
    .min(2)
    .max(max)
    .refine((value) => !/[\n<>]/.test(value) && !CONTROL_CHARACTERS.test(value) && !LINK_PATTERN.test(value));
}

const optionalLabel = (max: number) =>
  z
    .union([labelSchema(max), z.literal("")])
    .nullable()
    .optional()
    .transform((value) => (value === "" ? null : value));

/** Plain text rendered as React text on the site; line breaks are kept, runs of blank lines collapsed. */
const quoteSchema = z
  .string()
  .transform((value) => value.replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim())
  .pipe(z.string().min(20).max(600).refine((value) => !CONTROL_CHARACTERS.test(value)));

function isValidCalendarDate(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

/** Today's date in West Africa Time (UTC+1, no daylight saving). */
export function watToday(now: Date) {
  return new Date(now.getTime() + 60 * 60_000).toISOString().slice(0, 10);
}

/** Start of the current calendar year in WAT, for the "published this year" count. */
export function startOfWatYear(now: Date) {
  const year = Number(watToday(now).slice(0, 4));
  return new Date(Date.UTC(year, 0, 1) - 60 * 60_000);
}

const receivedOnSchema = z
  .union([z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(isValidCalendarDate), z.literal("")])
  .nullable()
  .optional()
  .transform((value) => (value === "" ? null : value));

const reviewFields = {
  displayName: labelSchema(80),
  context: optionalLabel(80),
  quote: quoteSchema,
  rating: z.number().int().min(1).max(5).nullable().optional(),
  serviceSlug: z.string().trim().max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).nullable().optional(),
  source: z.enum(reviewSources),
  receivedOn: receivedOnSchema,
  featured: z.boolean().optional(),
  status: z.enum(reviewStatuses).optional(),
  /** The editor confirms the customer agreed to the review and their full name appearing on the site. */
  consentConfirmed: z.boolean().optional(),
};

export const reviewInputSchema = z.object(reviewFields).strict();

export const expectedUpdatedAtSchema = z.iso.datetime({ offset: true });

/** A patch names the version it was edited from, so concurrent edits are detected. */
export const reviewPatchSchema = reviewInputSchema
  .partial()
  .extend({ expectedUpdatedAt: expectedUpdatedAtSchema })
  .strict()
  .refine((value) => Object.keys(value).some((key) => key !== "expectedUpdatedAt"));

export type ReviewInput = z.output<typeof reviewInputSchema>;
export type ReviewPatch = z.output<typeof reviewPatchSchema>;

/** What the public site may see: no consent, editor, or draft details. */
export type PublicReview = Pick<Review, "id" | "displayName" | "context" | "quote" | "rating" | "serviceSlug" | "receivedOn" | "featured">;

export function toPublicReview(review: Review): PublicReview {
  const { id, displayName, context, quote, rating, serviceSlug, receivedOn, featured } = review;
  return { id, displayName, context, quote, rating, serviceSlug, receivedOn, featured };
}

export type ReviewWritePlan =
  | { kind: "apply"; values: Partial<NewReview>; action: AuditAction; statusFrom: ReviewStatus | null; statusTo: ReviewStatus; fields: string[] }
  | { kind: "conflict" }
  | { kind: "consent-required" }
  | { kind: "future-date" };

type Existing = Pick<Review, "status" | "consentConfirmedAt" | "publishedAt" | "updatedAt">;

/**
 * Decide how a create (`existing` null) or patch is written. Publishing needs recorded
 * consent, consent cannot be withdrawn while the review is live, and a patch based on
 * an older version of the row is refused rather than silently overwriting it.
 */
export function planReviewWrite(existing: Existing | null, input: Partial<ReviewInput>, options: { now: Date; actorId: string | null; expectedUpdatedAt?: string }): ReviewWritePlan {
  const { now, actorId } = options;
  if (existing && Date.parse(options.expectedUpdatedAt ?? "") !== existing.updatedAt.getTime()) return { kind: "conflict" };
  if (input.receivedOn && input.receivedOn > watToday(now)) return { kind: "future-date" };

  const statusFrom = existing ? (existing.status as ReviewStatus) : null;
  const statusTo = input.status ?? statusFrom ?? "draft";
  const consented = input.consentConfirmed ?? Boolean(existing?.consentConfirmedAt);
  if (statusTo === "published" && !consented) return { kind: "consent-required" };

  const { consentConfirmed, ...fields } = input;
  const values: Partial<NewReview> = { ...fields, status: statusTo, updatedBy: actorId, updatedAt: now };
  if (consentConfirmed === true && !existing?.consentConfirmedAt) {
    values.consentConfirmedAt = now;
    values.consentConfirmedBy = actorId;
  }
  if (consentConfirmed === false) {
    values.consentConfirmedAt = null;
    values.consentConfirmedBy = null;
  }
  if (statusTo === "published" && statusFrom !== "published") values.publishedAt = now;
  if (statusTo !== "published") values.publishedAt = null;
  if (!existing) {
    values.createdBy = actorId;
    values.createdAt = now;
  }

  const action: AuditAction = !existing
    ? "review.create"
    : statusTo === "published" && statusFrom !== "published"
      ? "review.publish"
      : statusTo !== "published" && statusFrom === "published"
        ? "review.unpublish"
        : "review.update";
  const fieldNames = Object.keys(input).filter((key) => input[key as keyof ReviewInput] !== undefined).sort();
  return { kind: "apply", values, action, statusFrom, statusTo, fields: fieldNames };
}

/** A delete is refused when it is based on an older version of the row. */
export function deleteConflicts(existing: Pick<Review, "updatedAt">, expectedUpdatedAt: string) {
  return Date.parse(expectedUpdatedAt) !== existing.updatedAt.getTime();
}
