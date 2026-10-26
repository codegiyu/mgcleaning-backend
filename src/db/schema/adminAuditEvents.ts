import {
  index,
  jsonb,
  pgTable,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./adminUsers.js";

/**
 * Append-only record of admin actions. Metadata holds field names and status
 * transitions only; never copy inquiry contact details or notes into it.
 */
export const adminAuditEvents = pgTable(
  "admin_audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id").references(() => adminUsers.id, { onDelete: "set null" }),
    action: varchar("action", { length: 64 }).notNull(),
    entityType: varchar("entity_type", { length: 32 }).notNull(),
    entityId: varchar("entity_id", { length: 64 }),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    ipHash: varchar("ip_hash", { length: 64 }),
    requestId: varchar("request_id", { length: 64 }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("admin_audit_events_entity_idx").on(table.entityType, table.entityId, table.createdAt),
    index("admin_audit_events_actor_idx").on(table.actorId, table.createdAt),
    index("admin_audit_events_created_at_idx").on(table.createdAt),
  ],
);

export type AdminAuditEvent = typeof adminAuditEvents.$inferSelect;
export type NewAdminAuditEvent = typeof adminAuditEvents.$inferInsert;
