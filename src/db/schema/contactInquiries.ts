import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/** Initial lead-capture record. Service interest remains free text until MG confirms its catalogue. */
export const contactInquiries = pgTable(
  "contact_inquiries",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    name: varchar("name", { length: 120 }).notNull(),
    phone: varchar("phone", { length: 40 }).notNull(),
    email: varchar("email", { length: 320 }),
    publicReference: varchar("public_reference", { length: 32 }).notNull().unique(),
    idempotencyKey: varchar("idempotency_key", { length: 80 }).notNull().unique(),
    inquiryType: varchar("inquiry_type", { length: 24 }).notNull().default("contact"),
    topic: varchar("topic", { length: 120 }),
    preferredContactMethod: varchar("preferred_contact_method", { length: 24 }),
    serviceInterest: varchar("service_interest", { length: 120 }),
    preferredDate: varchar("preferred_date", { length: 40 }),
    preferredTime: varchar("preferred_time", { length: 80 }),
    location: varchar("location", { length: 240 }),
    spaceType: varchar("space_type", { length: 120 }),
    message: text("message").notNull(),
    source: varchar("source", { length: 120 }).notNull().default("website"),
    /** First-touch campaign attribution captured by the website; normalised lowercase tokens. */
    utmSource: varchar("utm_source", { length: 120 }),
    utmMedium: varchar("utm_medium", { length: 120 }),
    utmCampaign: varchar("utm_campaign", { length: 120 }),
    utmContent: varchar("utm_content", { length: 120 }),
    /** First page of the visit (path only), e.g. the article an Instagram post linked to. */
    landingPath: varchar("landing_path", { length: 200 }),
    status: varchar("status", { length: 32 }).notNull().default("new"),
    internalNote: text("internal_note"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("contact_inquiries_status_created_at_idx").on(table.status, table.createdAt),
    index("contact_inquiries_utm_source_created_at_idx").on(table.utmSource, table.createdAt),
  ],
);

export type ContactInquiry = typeof contactInquiries.$inferSelect;
export type NewContactInquiry = typeof contactInquiries.$inferInsert;
