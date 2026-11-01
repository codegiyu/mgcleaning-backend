import { adminUsers } from "./adminUsers.js";
import {
  index,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const adminSessions = pgTable(
  "admin_sessions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => adminUsers.id, { onDelete: "cascade" }),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    /** Refreshed at most every few minutes so session reads stay cheap. */
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }).notNull().defaultNow(),
    /** Truncated browser user agent, shown so an admin can recognise their own sessions. */
    userAgent: varchar("user_agent", { length: 200 }),
    ipHash: varchar("ip_hash", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("admin_sessions_user_id_idx").on(table.userId)],
);
