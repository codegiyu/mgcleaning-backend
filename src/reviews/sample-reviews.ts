import { count, sql } from "drizzle-orm";
import { notifyRevalidationQueued, queueRevalidation, REVIEWS_TAG } from "../cache/revalidation.js";
import { getDb } from "../db/client.js";
import { reviews, type NewReview } from "../db/schema/reviews.js";
import type { ReviewInput } from "./policy.js";

/**
 * Prefix on every sample's context line, so the owners (and anyone who finds the site
 * before launch) can tell placeholders from real customer reviews.
 */
export const SAMPLE_CONTEXT_PREFIX = "Sample ·";

/**
 * Placeholder reviews that show the owners how reviews look on the homepage and in the
 * dashboard before real ones exist. They are not customer words: the owners replace or
 * delete them from /admin/reviews before the site is announced.
 */
export const sampleReviews: (ReviewInput & { status: "draft" | "published" })[] = [
  {
    displayName: "Chiamaka Eze",
    context: `${SAMPLE_CONTEXT_PREFIX} Homeowner`,
    quote: "They called the day before to confirm what mattered most to us, and it showed. The kitchen and bathrooms were spotless, and they even wiped the skirting boards we had stopped noticing.",
    rating: 5,
    serviceSlug: "deep-cleaning",
    source: "whatsapp",
    receivedOn: "2026-10-18",
    featured: true,
    status: "published",
  },
  {
    displayName: "Tunde Adebayo",
    context: `${SAMPLE_CONTEXT_PREFIX} Office manager`,
    quote: "We moved to a weekly plan after the first visit. The team arrives on time, works around our staff, and the follow-up call the next day is a nice touch.",
    rating: 5,
    serviceSlug: "office-cleaning",
    source: "email",
    receivedOn: "2026-10-09",
    featured: true,
    status: "published",
  },
  {
    displayName: "Halima Bello",
    context: `${SAMPLE_CONTEXT_PREFIX} Short-let host`,
    quote: "Turnovers used to be my biggest worry between guests. Now the apartment is reset, linen changed, and photos sent to me before check-in.",
    rating: 5,
    serviceSlug: "short-let-turnover",
    source: "instagram",
    receivedOn: "2026-09-27",
    status: "published",
  },
  {
    displayName: "Emeka Nwosu",
    context: `${SAMPLE_CONTEXT_PREFIX} Homeowner`,
    quote: "Our cream sofa had two years of children on it. I honestly did not expect it to come back this well. Fair price, and they explained what each stain needed.",
    rating: 5,
    serviceSlug: "upholstery-cleaning",
    source: "whatsapp",
    receivedOn: "2026-09-14",
    status: "published",
  },
  {
    displayName: "Funmi Ogunleye",
    context: `${SAMPLE_CONTEXT_PREFIX} New homeowner`,
    quote: "After the builders left there was dust in every corner. Two days later the house was ready to move into. They were careful with the new fittings too.",
    rating: 4,
    serviceSlug: "post-construction-cleaning",
    source: "google",
    receivedOn: "2026-08-30",
    status: "published",
  },
  {
    displayName: "Ibrahim Musa",
    context: `${SAMPLE_CONTEXT_PREFIX} Restaurant owner`,
    quote: "The fumigation was scheduled after closing so we did not lose a day of business, and they told us exactly when it was safe to reopen.",
    rating: 5,
    serviceSlug: "fumigation",
    source: "in_person",
    receivedOn: "2026-08-12",
    status: "published",
  },
  {
    displayName: "Ngozi Okafor",
    context: `${SAMPLE_CONTEXT_PREFIX} Homeowner`,
    quote: "Our tiles had gone dull and we thought they needed replacing. After the polishing the living room looks brighter than when we moved in.",
    rating: 5,
    serviceSlug: "tile-polishing",
    source: "whatsapp",
    receivedOn: "2026-10-24",
    status: "draft",
  },
  {
    displayName: "Kelechi Obi",
    context: `${SAMPLE_CONTEXT_PREFIX} Retainer client`,
    quote: "Three months on the fortnightly plan and every visit has been consistent. Same standard, and they remember how we like things arranged.",
    rating: 4,
    serviceSlug: "retainer-cleaning",
    source: "email",
    receivedOn: "2026-10-28",
    status: "draft",
  },
];

/** Database rows for the samples; published ones carry the consent stamp the schema requires. */
export function sampleReviewRows(now: Date): NewReview[] {
  return sampleReviews.map((sample) => {
    const isPublished = sample.status === "published";
    return {
      displayName: sample.displayName,
      context: sample.context ?? null,
      quote: sample.quote,
      rating: sample.rating ?? null,
      serviceSlug: sample.serviceSlug ?? null,
      source: sample.source,
      receivedOn: sample.receivedOn ?? null,
      featured: sample.featured ?? false,
      status: sample.status,
      consentConfirmedAt: isPublished ? now : null,
      publishedAt: isPublished ? now : null,
      createdAt: now,
      updatedAt: now,
    };
  });
}

/**
 * Inserts the samples only while the reviews table is empty, so restarts never duplicate
 * them and never bring back samples once the owners have started managing reviews. The
 * count and insert share a transaction-scoped advisory lock, so two API instances
 * starting together cannot both seed.
 */
export async function seedSampleReviews(now = new Date()): Promise<{ inserted: number }> {
  const inserted = await getDb().transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('seed_sample_reviews'))`);
    const [existing] = await tx.select({ total: count() }).from(reviews);
    if (Number(existing?.total ?? 0) > 0) return 0;
    await tx.insert(reviews).values(sampleReviewRows(now));
    await queueRevalidation(tx, { tags: [REVIEWS_TAG], mode: "refresh" });
    return sampleReviews.length;
  });
  if (inserted) notifyRevalidationQueued();
  return { inserted };
}
