import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  date,
  index,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./adminUsers.js";

/**
 * Customer reviews the M&G team enters from the dashboard. Only `published` rows with
 * recorded consent reach the public site. Timestamps are written by the API (not the
 * database default) so `updated_at` round-trips exactly for edit-conflict checks.
 */
export const reviews = pgTable(
  "reviews",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    /** As shown publicly, e.g. "Amaka O." */
    displayName: varchar("display_name", { length: 80 }).notNull(),
    /** Optional line under the name, e.g. "Homeowner, Wuse 2". */
    context: varchar("context", { length: 80 }),
    quote: text("quote").notNull(),
    rating: smallint("rating"),
    serviceSlug: varchar("service_slug", { length: 120 }),
    /** Where the review came from: whatsapp, instagram, google, email, in_person, other. */
    source: varchar("source", { length: 24 }).notNull(),
    receivedOn: date("received_on"),
    featured: boolean("featured").notNull().default(false),
    status: varchar("status", { length: 24 }).notNull().default("draft"),
    /** Set when an editor confirms the customer agreed to publication; required to publish. */
    consentConfirmedAt: timestamp("consent_confirmed_at", { withTimezone: true }),
    consentConfirmedBy: uuid("consent_confirmed_by").references(() => adminUsers.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => adminUsers.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("reviews_public_order_idx").on(table.status, table.featured, table.receivedOn),
    index("reviews_status_published_at_idx").on(table.status, table.publishedAt),
    check("reviews_rating_range", sql`${table.rating} IS NULL OR ${table.rating} BETWEEN 1 AND 5`),
    check("reviews_published_needs_consent", sql`${table.status} <> 'published' OR ${table.consentConfirmedAt} IS NOT NULL`),
  ],
);

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
