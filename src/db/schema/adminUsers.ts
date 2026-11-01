import { sql } from "drizzle-orm";
import { boolean, check, pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const adminRoles = ["owner", "staff"] as const;
export type AdminRole = (typeof adminRoles)[number];

/**
 * Dashboard accounts. Owners manage accounts and site settings; staff handle enquiries,
 * reviews, and the journal. Accounts are deactivated rather than deleted so the audit
 * trail keeps pointing at a real person.
 */
export const adminUsers = pgTable(
  "admin_users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    email: varchar("email", { length: 320 }).notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: varchar("role", { length: 16 }).notNull().default("staff"),
    /** Set for new accounts and owner resets: the next sign-in must choose a new password. */
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    /** A deactivated account cannot sign in and its sessions are revoked. */
    deactivatedAt: timestamp("deactivated_at", { withTimezone: true }),
    passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [check("admin_users_role", sql`${table.role} IN ('owner', 'staff')`)],
);

export type AdminUser = typeof adminUsers.$inferSelect;
