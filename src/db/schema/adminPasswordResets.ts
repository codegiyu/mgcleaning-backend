import { index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";
import { adminUsers } from "./adminUsers.js";

/**
 * Emailed password-reset links. Only the SHA-256 of each token is stored, like session
 * tokens, so a database read cannot be turned into a working link. A link works once,
 * until `expires_at`; asking for a new one cancels the earlier ones.
 */
export const adminPasswordResets = pgTable(
  "admin_password_resets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("admin_password_resets_user_id_idx").on(table.userId)],
);

export type AdminPasswordReset = typeof adminPasswordResets.$inferSelect;
