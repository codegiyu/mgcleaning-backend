import { sql } from "drizzle-orm";
import { check, index, pgTable, timestamp, uuid, varchar } from "drizzle-orm/pg-core";

/**
 * Anonymous taps on the website's WhatsApp, Instagram, and call links, so campaign
 * reports still see visitors who message instead of filling in a form. No IP, user
 * agent, or other identifier is stored: only the channel, where on the site it was
 * tapped, and the tab's first-touch campaign tags.
 */
export const channelClicks = pgTable(
  "channel_clicks",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    channel: varchar("channel", { length: 16 }).notNull(),
    /** Which part of the page: header, page body, or footer. */
    placement: varchar("placement", { length: 16 }).notNull().default("page"),
    pagePath: varchar("page_path", { length: 200 }),
    utmSource: varchar("utm_source", { length: 120 }),
    utmMedium: varchar("utm_medium", { length: 120 }),
    utmCampaign: varchar("utm_campaign", { length: 120 }),
    utmContent: varchar("utm_content", { length: 120 }),
    landingPath: varchar("landing_path", { length: 200 }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("channel_clicks_created_at_idx").on(table.createdAt),
    index("channel_clicks_channel_created_at_idx").on(table.channel, table.createdAt),
    check("channel_clicks_channel", sql`${table.channel} IN ('whatsapp', 'instagram', 'phone')`),
    check("channel_clicks_placement", sql`${table.placement} IN ('header', 'page', 'footer')`),
  ],
);

export type ChannelClick = typeof channelClicks.$inferSelect;
export type NewChannelClick = typeof channelClicks.$inferInsert;
