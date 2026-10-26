import { pgTable, text, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

export const adminUsers = pgTable("admin_users", {
  id: uuid("id").defaultRandom().primaryKey(),
  email: varchar("email", { length: 320 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export type AdminUser = typeof adminUsers.$inferSelect;
