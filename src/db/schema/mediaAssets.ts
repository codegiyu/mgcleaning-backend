import {
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./adminUsers.js";

export const mediaStatuses = ["pending", "verified", "failed", "expired", "deleted"] as const;
export type MediaStatus = (typeof mediaStatuses)[number];

/**
 * One uploaded object in R2. Rows start `pending` when an upload URL is issued and
 * become `verified` only after the API has checked the stored object's size and bytes.
 */
export const mediaAssets = pgTable(
  "media_assets",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    key: varchar("key", { length: 512 }).notNull().unique(),
    publicUrl: text("public_url").notNull(),
    intent: varchar("intent", { length: 32 }).notNull(),
    contentType: varchar("content_type", { length: 64 }).notNull(),
    declaredBytes: integer("declared_bytes").notNull(),
    byteSize: integer("byte_size"),
    altText: varchar("alt_text", { length: 250 }),
    originalFilename: varchar("original_filename", { length: 200 }),
    status: varchar("status", { length: 16 }).notNull().default("pending"),
    failureReason: varchar("failure_reason", { length: 120 }),
    uploadedBy: uuid("uploaded_by").references(() => adminUsers.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    objectRemovedAt: timestamp("object_removed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("media_assets_status_created_at_idx").on(table.status, table.createdAt),
    index("media_assets_status_expires_at_idx").on(table.status, table.expiresAt),
  ],
);

export type MediaAsset = typeof mediaAssets.$inferSelect;
export type NewMediaAsset = typeof mediaAssets.$inferInsert;
