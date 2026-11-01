import { createHmac } from "node:crypto";
import { count, desc, gte, sql } from "drizzle-orm";
import { z } from "zod";
import { normalizeAttributionValue, normalizeLandingPath } from "../attribution.js";
import { getDb } from "../db/client.js";
import { channelClicks, type NewChannelClick } from "../db/schema/channelClicks.js";
import { env } from "../env.js";
import { lazyProducerConnection } from "../queue/redis.js";

export const clickChannels = ["whatsapp", "instagram", "phone"] as const;
export type ClickChannel = (typeof clickChannels)[number];
export const clickPlacements = ["header", "page", "footer"] as const;

/** A beacon is a few hundred bytes; anything larger is not from the website. */
export const MAX_CLICK_BODY_BYTES = 2048;
/** Per visitor IP; generous for real browsing, tight enough to stop a script inflating counts. */
export const CLICK_LIMIT_PER_WINDOW = 30;
export const CLICK_WINDOW_SECONDS = 10 * 60;
/** The dashboard summary covers this many days. */
export const CLICK_SUMMARY_DAYS = 30;

/**
 * The channel must be one we know; everything else is campaign data from the visitor's
 * URL, so it is normalised or dropped, never trusted and never a reason to reject.
 */
const clickSchema = z
  .object({
    channel: z.enum(clickChannels),
    placement: z.enum(clickPlacements).catch("page").default("page"),
    pagePath: z.unknown().optional(),
    utmSource: z.unknown().optional(),
    utmMedium: z.unknown().optional(),
    utmCampaign: z.unknown().optional(),
    utmContent: z.unknown().optional(),
    landingPath: z.unknown().optional(),
  })
  .strict();

/** Parse a beacon body (sent as text/plain to avoid a CORS preflight) into a row, or null. */
export function parseChannelClick(body: string): NewChannelClick | null {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  const parsed = clickSchema.safeParse(value);
  if (!parsed.success) return null;
  const input = parsed.data;
  return {
    channel: input.channel,
    placement: input.placement,
    pagePath: normalizeLandingPath(input.pagePath) ?? null,
    utmSource: normalizeAttributionValue(input.utmSource) ?? null,
    utmMedium: normalizeAttributionValue(input.utmMedium) ?? null,
    utmCampaign: normalizeAttributionValue(input.utmCampaign) ?? null,
    utmContent: normalizeAttributionValue(input.utmContent) ?? null,
    landingPath: normalizeLandingPath(input.landingPath) ?? null,
  };
}

const connection = lazyProducerConnection();

/** Counts taps per hashed IP in a fixed window; the IP itself is never stored. */
export async function allowChannelClick(ip: string) {
  const redis = await connection.get();
  const key = `events:channel-click:${createHmac("sha256", env.INQUIRY_SECURITY_SECRET).update(ip).digest("hex")}`;
  const taps = await redis.incr(key);
  if (taps === 1) await redis.expire(key, CLICK_WINDOW_SECONDS);
  return taps <= CLICK_LIMIT_PER_WINDOW;
}

export const closeChannelClickRedis = () => connection.close();

export async function recordChannelClick(click: NewChannelClick) {
  await getDb().insert(channelClicks).values(click);
}

export type ChannelClickSummary = {
  days: number;
  total: number;
  byChannel: Record<ClickChannel, number>;
  /** Campaign sources with the most taps; untagged visits count as "direct". */
  topSources: { source: string; count: number }[];
};

export async function summarizeChannelClicks(now = new Date(), days = CLICK_SUMMARY_DAYS): Promise<ChannelClickSummary> {
  const since = gte(channelClicks.createdAt, new Date(now.getTime() - days * 86_400_000));
  const source = sql<string>`coalesce(${channelClicks.utmSource}, 'direct')`;
  const db = getDb();
  const [perChannel, perSource] = await Promise.all([
    db.select({ channel: channelClicks.channel, total: count() }).from(channelClicks).where(since).groupBy(channelClicks.channel),
    db.select({ source, total: count() }).from(channelClicks).where(since).groupBy(source).orderBy(desc(count())).limit(5),
  ]);
  const byChannel: Record<ClickChannel, number> = { whatsapp: 0, instagram: 0, phone: 0 };
  for (const row of perChannel) {
    if ((clickChannels as readonly string[]).includes(row.channel)) byChannel[row.channel as ClickChannel] = Number(row.total);
  }
  return {
    days,
    total: byChannel.whatsapp + byChannel.instagram + byChannel.phone,
    byChannel,
    topSources: perSource.map((row) => ({ source: row.source, count: Number(row.total) })),
  };
}
