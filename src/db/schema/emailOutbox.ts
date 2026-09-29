import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { contactInquiries } from "./contactInquiries.js";

export const emailOutbox = pgTable(
  "email_outbox",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    inquiryId: uuid("inquiry_id")
      .notNull()
      .references(() => contactInquiries.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 24 }).notNull(),
    to: varchar("to_address", { length: 320 }).notNull(),
    subject: varchar("subject", { length: 240 }).notNull(),
    title: varchar("title", { length: 180 }).notNull(),
    message: text("message").notNull(),
    status: varchar("status", { length: 24 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    uniqueIndex("email_outbox_inquiry_kind_idx").on(table.inquiryId, table.kind),
    index("email_outbox_status_available_at_idx").on(table.status, table.availableAt),
  ],
);

export type EmailOutbox = typeof emailOutbox.$inferSelect;
export type NewEmailOutbox = typeof emailOutbox.$inferInsert;
