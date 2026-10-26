import {
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

/**
 * Transactional outbox for website cache invalidation. Rows are written in the same
 * transaction as the post change, so an unpublish can never be committed without a
 * pending instruction to purge it from the public cache.
 */
export const cacheRevalidations = pgTable(
  "cache_revalidations",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    tags: jsonb("tags").$type<string[]>().notNull(),
    /** `remove` expires immediately (unpublish); `refresh` serves stale while refreshing. */
    mode: varchar("mode", { length: 16 }).notNull(),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    availableAt: timestamp("available_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    sentAt: timestamp("sent_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [index("cache_revalidations_status_available_at_idx").on(table.status, table.availableAt)],
);

export type CacheRevalidation = typeof cacheRevalidations.$inferSelect;
