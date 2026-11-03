import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { adminUsers } from "./adminUsers.js";
import { mediaAssets } from "./mediaAssets.js";

export const galleryItemTypes = ["image", "video"] as const;
export type GalleryItemType = (typeof galleryItemTypes)[number];

export const galleryLayouts = ["featured", "tall", "standard", "wide"] as const;
export type GalleryLayout = (typeof galleryLayouts)[number];

export const galleryItemStatuses = ["draft", "published"] as const;
export type GalleryItemStatus = (typeof galleryItemStatuses)[number];

/**
 * Photos and videos the M&G team publishes on the public gallery. Only `published`
 * rows with confirmed rights reach the site, and a published video needs a poster.
 * Referenced uploads cannot be deleted while an item uses them. Timestamps are written
 * by the API (not the database default) so `updated_at` round-trips exactly for
 * edit-conflict checks.
 */
export const galleryItems = pgTable(
  "gallery_items",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    type: varchar("type", { length: 8 }).notNull(),
    /** The photo or video itself; one upload backs at most one item. */
    mediaId: uuid("media_id").notNull().references(() => mediaAssets.id, { onDelete: "restrict" }),
    /** Still image shown before a video plays; required to publish a video. */
    posterMediaId: uuid("poster_media_id").references(() => mediaAssets.id, { onDelete: "restrict" }),
    altText: varchar("alt_text", { length: 250 }).notNull(),
    caption: varchar("caption", { length: 200 }),
    serviceSlug: varchar("service_slug", { length: 120 }),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    layout: varchar("layout", { length: 16 }).notNull().default("standard"),
    /** Ascending display order; rewritten as a whole when an editor reorders. */
    position: integer("position").notNull(),
    status: varchar("status", { length: 24 }).notNull().default("draft"),
    /** Set when an editor confirms M&G owns the media and anyone shown agreed; required to publish. */
    rightsConfirmedAt: timestamp("rights_confirmed_at", { withTimezone: true }),
    rightsConfirmedBy: uuid("rights_confirmed_by").references(() => adminUsers.id, { onDelete: "set null" }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdBy: uuid("created_by").references(() => adminUsers.id, { onDelete: "set null" }),
    updatedBy: uuid("updated_by").references(() => adminUsers.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("gallery_items_media_id_unique").on(table.mediaId),
    index("gallery_items_poster_media_id_idx").on(table.posterMediaId),
    index("gallery_items_public_order_idx").on(table.status, table.position),
    check("gallery_items_type_valid", sql`${table.type} IN ('image', 'video')`),
    check("gallery_items_layout_valid", sql`${table.layout} IN ('featured', 'tall', 'standard', 'wide')`),
    check("gallery_items_status_valid", sql`${table.status} IN ('draft', 'published')`),
    check("gallery_items_published_needs_rights", sql`${table.status} <> 'published' OR ${table.rightsConfirmedAt} IS NOT NULL`),
    check("gallery_items_published_video_needs_poster", sql`${table.status} <> 'published' OR ${table.type} <> 'video' OR ${table.posterMediaId} IS NOT NULL`),
  ],
);

export type GalleryItem = typeof galleryItems.$inferSelect;
export type NewGalleryItem = typeof galleryItems.$inferInsert;
