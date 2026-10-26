import { eq } from "drizzle-orm";
import { getDb } from "../db/client.js";
import { siteSettings, type SiteSettings } from "../db/schema/siteSettings.js";
import { env } from "../env.js";

export const SITE_SETTINGS_ID = 1;

type Selectable = Pick<ReturnType<typeof getDb>, "select">;

export async function readSiteSettings(executor: Selectable = getDb()): Promise<SiteSettings | null> {
  const [row] = await executor.select().from(siteSettings).where(eq(siteSettings.id, SITE_SETTINGS_ID)).limit(1);
  return row ?? null;
}

/** The admin-configured inbox wins; the deployment's INQUIRY_NOTIFICATION_TO remains the fallback. */
export function effectiveNotificationEmail(settings: Pick<SiteSettings, "inquiryNotificationEmail"> | null) {
  return settings?.inquiryNotificationEmail ?? env.INQUIRY_NOTIFICATION_TO;
}
