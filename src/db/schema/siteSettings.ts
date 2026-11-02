import { check, pgTable, smallint, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { adminUsers } from "./adminUsers.js";

/**
 * Operational settings the M&G team can change without a deploy. Exactly one row
 * (id = 1). Public business facts stay in the web app's governed content manifests.
 */
export const siteSettings = pgTable(
  "site_settings",
  {
    id: smallint("id").primaryKey().default(1),
    /** Extra inbox for new-inquiry alerts, alongside INQUIRY_NOTIFICATION_TO, which always gets them. */
    inquiryNotificationEmail: varchar("inquiry_notification_email", { length: 320 }),
    /** Pre-filled author on new articles. */
    defaultAuthorName: varchar("default_author_name", { length: 120 }),
    updatedBy: uuid("updated_by").references(() => adminUsers.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  () => [check("site_settings_single_row", sql`id = 1`)],
);

export type SiteSettings = typeof siteSettings.$inferSelect;
