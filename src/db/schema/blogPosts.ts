import {
  index,
  pgTable,
  text,
  timestamp,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

export const blogPosts = pgTable(
  "blog_posts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    slug: varchar("slug", { length: 180 }).notNull().unique(),
    title: varchar("title", { length: 180 }).notNull(),
    excerpt: varchar("excerpt", { length: 320 }).notNull(),
    body: text("body").notNull(),
    category: varchar("category", { length: 80 }).notNull(),
    authorName: varchar("author_name", { length: 120 }).notNull().default("M&G Cleaning Services"),
    serviceSlug: varchar("service_slug", { length: 120 }),
    coverImageUrl: text("cover_image_url"),
    coverImageAlt: varchar("cover_image_alt", { length: 250 }),
    seoTitle: varchar("seo_title", { length: 180 }),
    seoDescription: varchar("seo_description", { length: 320 }),
    status: varchar("status", { length: 24 }).notNull().default("draft"),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => [
    index("blog_posts_status_published_at_idx").on(table.status, table.publishedAt),
    index("blog_posts_category_idx").on(table.category),
    index("blog_posts_service_slug_idx").on(table.serviceSlug),
  ],
);

export type BlogPost = typeof blogPosts.$inferSelect;
export type NewBlogPost = typeof blogPosts.$inferInsert;
